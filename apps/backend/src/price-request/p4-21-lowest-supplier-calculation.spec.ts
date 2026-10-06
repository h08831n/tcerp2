import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  priceRequestService,
  supplierOffersService,
  createParty,
  createVariant,
} from '../testing/p4-fixtures';

/**
 * p4-21 lowest-supplier-calculation: for a day the daily-lowest endpoint
 * returns ONLY the minimum-priced offer(s) per (variant, uom).
 * p4-22 tie-behavior: two EQUAL lowest offers are BOTH returned (co-lowest).
 */
describeIntegration('p4-21/p4-22 daily-lowest supplier intelligence', () => {
  const prisma = integrationPrisma();
  const marker = `p4l${Date.now()}`;
  let actorId = '';
  let supplierA = { id: '', nameFa: '' };
  let supplierB = { id: '', nameFa: '' };
  let supplierC = { id: '', nameFa: '' };
  let v1 = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let v2 = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let v3 = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let requestAId = '';
  let requestAlineId = '';
  let requestBId = '';
  let requestBlineId = '';
  let tieRequestId = '';
  let tieLineId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplierA = await createParty(prisma, ['SUPPLIER'], `${marker}-A`);
    supplierB = await createParty(prisma, ['SUPPLIER'], `${marker}-B`);
    supplierC = await createParty(prisma, ['SUPPLIER'], `${marker}-C`);
    v1 = await createVariant(prisma, `${marker}-1`);
    v2 = await createVariant(prisma, `${marker}-2`);
    v3 = await createVariant(prisma, `${marker}-3`);

    const prService = priceRequestService(prisma);
    const offers = supplierOffersService(prisma);

    // Request A / variant 1: A=34300, B=34450, C=34250 → C is lowest.
    const ra = await prService.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: v1.variantId, requestedQuantity: 10 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    requestAId = ra.id;
    requestAlineId = ra.lines[0].id;
    await offers.addOffer(INTEGRATION_COMPANY_ID, requestAlineId, { supplierPartyId: supplierA.id, offeredPrice: 34300 }, { id: actorId, username: 'admin' }, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, requestAlineId, { supplierPartyId: supplierB.id, offeredPrice: 34450 }, { id: actorId, username: 'admin' }, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, requestAlineId, { supplierPartyId: supplierC.id, offeredPrice: 34250 }, { id: actorId, username: 'admin' }, {});

    // Request B / variant 2: A=50000, B=49000 → B lowest.
    const rb = await prService.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: v2.variantId, requestedQuantity: 4 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    requestBId = rb.id;
    requestBlineId = rb.lines[0].id;
    await offers.addOffer(INTEGRATION_COMPANY_ID, requestBlineId, { supplierPartyId: supplierA.id, offeredPrice: 50000 }, { id: actorId, username: 'admin' }, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, requestBlineId, { supplierPartyId: supplierB.id, offeredPrice: 49000 }, { id: actorId, username: 'admin' }, {});

    // Tie on variant 3: A=C=33000 → BOTH co-lowest.
    const rt = await prService.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: v3.variantId, requestedQuantity: 2 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    tieRequestId = rt.id;
    tieLineId = rt.lines[0].id;
    await offers.addOffer(INTEGRATION_COMPANY_ID, tieLineId, { supplierPartyId: supplierA.id, offeredPrice: 33000 }, { id: actorId, username: 'admin' }, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, tieLineId, { supplierPartyId: supplierC.id, offeredPrice: 33000 }, { id: actorId, username: 'admin' }, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, tieLineId, { supplierPartyId: supplierB.id, offeredPrice: 33500 }, { id: actorId, username: 'admin' }, {});
  });

  it('p4-21: the cheapest supplier per (variant, uom) is selected', async () => {
    const offers = supplierOffersService(prisma);
    const lowest = await offers.getDailyLowest(INTEGRATION_COMPANY_ID, { variantId: v1.variantId });

    expect(lowest).toHaveLength(1); // one (variant, uom) partition for v1 today
    const group = lowest[0];
    // ONLY minimum-priced offers survive…
    expect(group.offers.every((o: { offeredPrice: string }) => Number(o.offeredPrice) === 34250)).toBe(true);
    // …and for the untied line the single cheapest is C (34250).
    expect(group.offers).toHaveLength(1);
    expect(group.offers[0].supplierPartyId).toBe(supplierC.id);
  });

  it('p4-22: a tie returns ALL co-lowest offers', async () => {
    const offers = supplierOffersService(prisma);
    const tieGroups = await offers.getDailyLowest(INTEGRATION_COMPANY_ID);
    const tie = tieGroups.find((g: { offers: unknown[] }) => g.offers.length > 1);
    expect(tie).toBeDefined();
    expect(tie!.offers).toHaveLength(2);
    const ids = tie!.offers.map((o: { supplierPartyId: string }) => o.supplierPartyId).sort();
    expect(ids).toEqual([supplierA.id, supplierC.id].sort());
  });

  it('p4-21b: the 60-day report counts daily-lowest wins per supplier+product', async () => {
    const offers = supplierOffersService(prisma);
    const report = await offers.supplierLowestReport(INTEGRATION_COMPANY_ID, 60);

    const supplierCVariant1 = report.items.find(
      (i: { supplierPartyId: string; productVariantId: string }) =>
        i.supplierPartyId === supplierC.id && i.productVariantId === v1.variantId,
    );
    // Supplier C won variant 1 once today (34250).
    expect(supplierCVariant1?.daysLowest).toBe(1);

    const supplierBVariant2 = report.items.find(
      (i: { supplierPartyId: string; productVariantId: string }) =>
        i.supplierPartyId === supplierB.id && i.productVariantId === v2.variantId,
    );
    expect(supplierBVariant2?.daysLowest).toBe(1); // 49000 < 50000
  });

  afterAll(async () => {
    await prisma.priceRequest.deleteMany({ where: { id: { in: [requestAId, requestBId, tieRequestId] } } });
    await prisma.party.deleteMany({ where: { id: { in: [supplierA.id, supplierB.id, supplierC.id] } } });
    for (const v of [v1, v2, v3]) {
      await prisma.productVariant.deleteMany({ where: { id: v.variantId } });
      await prisma.productTemplate.deleteMany({ where: { id: v.templateId } });
    }
    await disconnectIntegrationPrisma();
  });
});
