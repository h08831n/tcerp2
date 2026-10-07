import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, supplierOffersService, priceRequestService, createVariant } from '../testing/p4-fixtures';
import { todayKey } from '../pricing/day';

/**
 * p5-15 cheapest-supplier-report: per-supplier win counts over N days for
 * ONE variant (uom-scoped) — ties count for ALL co-lowest suppliers; no
 * average price anywhere.
 */
describeIntegration('p5-15 cheapest-supplier-report', () => {
  const prisma = integrationPrisma();
  const marker = `p5-15-${Date.now()}`;
  let actorId = '';
  let supplierA = { id: '', nameFa: '' };
  let supplierB = { id: '', nameFa: '' };
  let supplierC = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  const requestIds: string[] = [];

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplierA = await createParty(prisma, ['SUPPLIER'], `${marker}-A`);
    supplierB = await createParty(prisma, ['SUPPLIER'], `${marker}-B`);
    supplierC = await createParty(prisma, ['SUPPLIER'], `${marker}-C`);
    variant = await createVariant(prisma, marker);
    void todayKey;
  });

  it('win counts: ties counted for all co-lowest, losers not counted', async () => {
    const prService = priceRequestService(prisma);
    const offers = supplierOffersService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Day 1 (today): A=100, B=200 → A wins.
    const r1 = await prService.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: variant.variantId, requestedQuantity: 1 }] },
      actor,
      {},
    );
    requestIds.push(r1.id);
    await offers.addOffer(INTEGRATION_COMPANY_ID, r1.lines[0].id, { supplierPartyId: supplierA.id, offeredPrice: 100, offeredAt: now.toISOString() }, actor, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, r1.lines[0].id, { supplierPartyId: supplierB.id, offeredPrice: 200, offeredAt: now.toISOString() }, actor, {});

    // Day 2 (yesterday): A=300, C=300, B=400 → A AND C co-lowest (both count).
    const r2 = await prService.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: variant.variantId, requestedQuantity: 1 }] },
      actor,
      {},
    );
    requestIds.push(r2.id);
    await offers.addOffer(INTEGRATION_COMPANY_ID, r2.lines[0].id, { supplierPartyId: supplierA.id, offeredPrice: 300, offeredAt: yesterday.toISOString() }, actor, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, r2.lines[0].id, { supplierPartyId: supplierC.id, offeredPrice: 300, offeredAt: yesterday.toISOString() }, actor, {});
    await offers.addOffer(INTEGRATION_COMPANY_ID, r2.lines[0].id, { supplierPartyId: supplierB.id, offeredPrice: 400, offeredAt: yesterday.toISOString() }, actor, {});

    const report = await offers.cheapestReport(INTEGRATION_COMPANY_ID, {
      variantId: variant.variantId,
      days: 30,
    });

    expect(report.variantId).toBe(variant.variantId);
    expect(report.days).toBe(30);
    const bySupplier = new Map(
      report.items.map((i: { supplierPartyId: string; winCount: number }) => [i.supplierPartyId, i] as const),
    );
    expect(bySupplier.get(supplierA.id)!.winCount).toBe(2);
    expect(bySupplier.get(supplierC.id)!.winCount).toBe(1); // tie counted for co-lowest
    expect(bySupplier.get(supplierB.id)).toBeUndefined(); // never lowest → absent
    // No average price anywhere in the payload.
    expect(JSON.stringify(report)).not.toContain('average');
  });

  it('uom filter scopes the report', async () => {
    const offers = supplierOffersService(prisma);
    const report = await offers.cheapestReport(INTEGRATION_COMPANY_ID, {
      variantId: variant.variantId,
      days: 30,
      uomId: variant.uomId,
    });
    const a = report.items.find((i: { supplierPartyId: string }) => i.supplierPartyId === supplierA.id)!;
    expect(a.winCount).toBe(2);
  });

  afterAll(async () => {
    await prisma.priceRequest.deleteMany({ where: { id: { in: requestIds } } });
    await prisma.party.deleteMany({ where: { id: { in: [supplierA.id, supplierB.id, supplierC.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
