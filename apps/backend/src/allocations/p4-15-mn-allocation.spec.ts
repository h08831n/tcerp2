import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  salesService,
  purchaseService,
  allocationsService,
  createParty,
  createVariant,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4-15 mn-allocation: a 50-ton purchase line can feed 20 + 30 ton sales
 * lines (M:N, line level); a third allocation that would exceed the
 * ordered quantity is rejected with ALLOCATION_EXCEEDS_QUANTITY.
 * p4-16 concurrent-over-allocation-protected: two PARALLEL allocations
 * summing above the ordered quantity — exactly ONE may succeed.
 */
describeIntegration('p4-15/p4-16 sales ↔ purchase allocations', () => {
  const prisma = integrationPrisma();
  const marker = `p4g${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let sale1Id = '';
  let sale2Id = '';
  let sale3Id = '';
  let purchaseId = '';
  let purchaseLineId = '';
  const salesLineIds: string[] = [];

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    supplier = await createParty(prisma, ['SUPPLIER'], marker);
    variant = await createVariant(prisma, marker);

    const sales = salesService(prisma);
    const purchase = purchaseService(prisma);

    for (const quantity of [20, 30, 5]) {
      const doc = await sales.create(
        INTEGRATION_COMPANY_ID,
        { userId: actorId, scope: 'ALL' },
        {
          customerPartyId: customer.id,
          lines: [{ productVariantId: variant.variantId, quantity, unitPrice: 0 }],
        },
        { id: actorId, username: 'admin' },
        {},
      );
      if (quantity === 20) sale1Id = doc.id;
      if (quantity === 30) sale2Id = doc.id;
      if (quantity === 5) sale3Id = doc.id;
      salesLineIds.push(doc.lines[0].id);
    }

    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [{ productVariantId: variant.variantId, quantity: 50, unitPrice: 0 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    purchaseId = po.id;
    purchaseLineId = po.lines[0].id;
  });

  it('p4-15: 20 + 30 from a 50-ton purchase line, then a 5-ton extra is blocked', async () => {
    const allocations = allocationsService(prisma);

    const a1 = await allocations.create(
      INTEGRATION_COMPANY_ID,
      { salesLineId: salesLineIds[0], purchaseLineId, allocatedQuantity: 20 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(Number(a1.allocatedQuantity)).toBe(20);

    const a2 = await allocations.create(
      INTEGRATION_COMPANY_ID,
      { salesLineId: salesLineIds[1], purchaseLineId, allocatedQuantity: 30 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(Number(a2.allocatedQuantity)).toBe(30);

    // Over-allocation on the PURCHASE side (20+30 already = 50).
    await expect(
      allocations.create(
        INTEGRATION_COMPANY_ID,
        { salesLineId: salesLineIds[2], purchaseLineId, allocatedQuantity: 5 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'ALLOCATION_EXCEEDS_QUANTITY' });

    // p4-15b: allocation to a DIFFERENT variant is rejected.
    const other = await createVariant(prisma, `${marker}-other`);
    const sales = salesService(prisma);
    const otherSale = await sales.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: other.variantId, quantity: 5, unitPrice: 0 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    await expect(
      allocations.create(
        INTEGRATION_COMPANY_ID,
        { salesLineId: otherSale.lines[0].id, purchaseLineId, allocatedQuantity: 5 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'ALLOCATION_VARIANT_MISMATCH' });

    // List by purchaseDocument joins through the lines.
    const list = await allocationsService(prisma).list(INTEGRATION_COMPANY_ID, {
      purchaseDocumentId: purchaseId,
      page: 1,
      pageSize: 20,
      sortDir: 'desc',
      skip: 0,
      take: 20,
    });
    expect(list.total).toBe(2);

    await cleanupSalesDocument(prisma, otherSale.id);
  });

  it('p4-16: two parallel allocations summing > ordered → exactly ONE commits', async () => {
    const allocations = allocationsService(prisma);
    const results = await Promise.allSettled([
      allocations.create(
        INTEGRATION_COMPANY_ID,
        { salesLineId: salesLineIds[2], purchaseLineId, allocatedQuantity: 30 },
        { id: actorId, username: 'admin' },
        {},
      ),
      allocations.create(
        INTEGRATION_COMPANY_ID,
        { salesLineId: salesLineIds[2], purchaseLineId, allocatedQuantity: 30 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ]);

    // The purchase line is already fully allocated (20+30=50) and the third
    // sales line only holds 5 tons — BOTH must fail without corrupting
    // state; run the real race on a fresh pair below.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(0);

    // Fresh sale line (8 tons) + purchase line (10 tons); two racing
    // 8-ton allocations — 8+8 > 10 on the purchase side.
    const sales = salesService(prisma);
    const raceSale = await sales.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 8, unitPrice: 0 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    const raceSalesLineId = raceSale.lines[0].id;

    const purchase = purchaseService(prisma);
    const po2 = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 0 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    const po2LineId = po2.lines[0].id;

    const race = await Promise.allSettled([
      allocations.create(
        INTEGRATION_COMPANY_ID,
        { salesLineId: raceSalesLineId, purchaseLineId: po2LineId, allocatedQuantity: 8 },
        { id: actorId, username: 'admin' },
        {},
      ),
      allocations.create(
        INTEGRATION_COMPANY_ID,
        { salesLineId: raceSalesLineId, purchaseLineId: po2LineId, allocatedQuantity: 8 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ]);
    const committed = race.filter((r) => r.status === 'fulfilled');
    expect(committed).toHaveLength(1); // exactly one
    const allocated = await prisma.salesPurchaseAllocation.aggregate({
      where: { purchaseLineId: po2LineId },
      _sum: { allocatedQuantity: true },
    });
    expect(Number(allocated._sum.allocatedQuantity)).toBe(8); // never 16

    await cleanupSalesDocument(prisma, raceSale.id);
    await cleanupPurchaseDocument(prisma, po2.id);
  });

  afterAll(async () => {
    for (const id of [sale1Id, sale2Id, sale3Id]) await cleanupSalesDocument(prisma, id);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
