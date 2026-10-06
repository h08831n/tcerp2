import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  priceRequestService,
  supplierOffersService,
  createParty,
  createVariant,
} from '../testing/p4-fixtures';
import { ForbiddenError } from '../common/errors';

/**
 * p4-20 multiple-offers-per-line: several suppliers can offer on ONE price
 * request line (34,300 / 34,450 / 34,250 …); the first offer moves the
 * request OPEN → OFFERED.
 * p4-23 offer-requires-supplier-role: an offer from a non-SUPPLIER party is
 * rejected with NOT_A_SUPPLIER.
 */
describeIntegration('p4-20/p4-23 supplier offers', () => {
  const prisma = integrationPrisma();
  const marker = `p4k${Date.now()}`;
  let actorId = '';
  let supplierA = { id: '', nameFa: '' };
  let supplierB = { id: '', nameFa: '' };
  let nonSupplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let requestId = '';
  let lineId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplierA = await createParty(prisma, ['SUPPLIER'], `${marker}-A`);
    supplierB = await createParty(prisma, ['SUPPLIER'], `${marker}-B`);
    nonSupplier = await createParty(prisma, ['CUSTOMER'], `${marker}-N`);
    variant = await createVariant(prisma, marker);
    const service = priceRequestService(prisma);
    const request = await service.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: variant.variantId, requestedQuantity: 10 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    requestId = request.id;
    lineId = request.lines[0].id;
  });

  it('p4-23: a party without the SUPPLIER role cannot offer', async () => {
    const offers = supplierOffersService(prisma);
    await expect(
      offers.addOffer(
        INTEGRATION_COMPANY_ID,
        lineId,
        { supplierPartyId: nonSupplier.id, offeredPrice: 34000 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'NOT_A_SUPPLIER' });
    expect(new ForbiddenError('X').statusCode).toBe(403);
  });

  it('p4-20: three suppliers offer on the same line; status becomes OFFERED', async () => {
    const offers = supplierOffersService(prisma);
    const o1 = await offers.addOffer(INTEGRATION_COMPANY_ID, lineId, { supplierPartyId: supplierA.id, offeredPrice: 34300 }, { id: actorId, username: 'admin' }, {});
    const o2 = await offers.addOffer(INTEGRATION_COMPANY_ID, lineId, { supplierPartyId: supplierB.id, offeredPrice: 34450 }, { id: actorId, username: 'admin' }, {});
    const o3 = await offers.addOffer(INTEGRATION_COMPANY_ID, lineId, { supplierPartyId: supplierA.id, offeredPrice: 34250 }, { id: actorId, username: 'admin' }, {});

    const list = await offers.listByLine(INTEGRATION_COMPANY_ID, lineId);
    expect(list).toHaveLength(3);
    expect(list.map((o: { offeredPrice: { toString(): string } }) => o.offeredPrice.toString())).toEqual(['34250', '34300', '34450']);

    const row = await prisma.priceRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('OFFERED');

    // The owner may edit their own offer before conversion…
    const updated = await offers.updateOffer(
      INTEGRATION_COMPANY_ID,
      lineId,
      o2.id,
      { offeredPrice: 34400 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(updated.offeredPrice.toString()).toBe('34400');

    // …and delete it.
    await offers.deleteOffer(INTEGRATION_COMPANY_ID, lineId, o1.id, { id: actorId, username: 'admin' }, {});
    expect(await offers.listByLine(INTEGRATION_COMPANY_ID, lineId)).toHaveLength(2);
  });

  afterAll(async () => {
    await prisma.priceRequest.deleteMany({ where: { id: requestId } });
    await prisma.party.deleteMany({ where: { id: { in: [supplierA.id, supplierB.id, nonSupplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
