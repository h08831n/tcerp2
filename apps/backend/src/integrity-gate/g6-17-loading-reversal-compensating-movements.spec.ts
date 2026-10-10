import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { loadingService, inventoryService, goodsReceiptService, stockQuery, cleanupLoading } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  createSupplierAndCustomer,
  cleanupPartyLocations,
  ensureMainWarehouse,
} from './g6-helpers';

/**
 * g6-17 — loading-reversal-compensating-movements: reversing a CONFIRMED
 * warehouse loading writes ONE COMPENSATING movement per original — swapped
 * endpoints, `reversalOfMovementId` linkage, `loading-rev:{id}:line:{lineId}`
 * keys — and the internal stock returns to its pre-loading value. The
 * original flips to REVERSED (+reason) and is immutable forever.
 */
describeIntegration('g6-17 loading-reversal-compensating-movements', () => {
  const prisma = integrationPrisma();
  const marker = `g6-17-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  it('reverse restores the stock and links the compensation', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    customerId = parties.customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    // 30 into MAIN; 12 out by the loading; reverse → 30 again.
    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 30, uomId: uoms.kgId, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    const receipt = await goodsReceiptService(prisma).create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 30, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptId = receipt.id;
    await goodsReceiptService(prisma).confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        customerPartyId: customerId,
        lines: [{ productVariantId: variantId, actualQuantity: 12 }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const before = await inventoryService(prisma).stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((before.items[0] as { stock: { toString(): string } }).stock)).toBe(18);

    const reversed = await loading.reverse(INTEGRATION_COMPANY_ID, loadingId, { reason: 'اشتباه در ثبت بارگیری' }, actor, {});
    expect(reversed.status).toBe('REVERSED');
    expect(reversed.reversalReason).toBe('اشتباه در ثبت بارگیری');
    expect(reversed.reversals).toHaveLength(0); // this IS the reversal
    void reversed;

    // The compensating movement: swapped endpoints + linkage + rev key.
    const originals = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
      orderBy: { createdAt: 'asc' },
    });
    const compensations = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING_REVERSAL', sourceEntityId: loadingId },
    });
    expect(originals).toHaveLength(1);
    expect(compensations).toHaveLength(1);
    const [original] = originals;
    const [compensation] = compensations;
    expect(compensation.reversalOfMovementId).toBe(original.id);
    expect(compensation.sourceLocationId).toBe(original.destinationLocationId);
    expect(compensation.destinationLocationId).toBe(original.sourceLocationId);
    expect(compensation.direction).toBe(original.direction === 'OUT' ? 'IN' : 'OUT');
    expect(compensation.idempotencyKey).toBe(`loading-rev:${loadingId}:line:${original.idempotencyKey.split(':line:')[1]}`);
    expect(Number(compensation.normalizedQuantity)).toBe(Number(original.normalizedQuantity));
    expect(compensation.inventoryUomId).toBe(original.inventoryUomId);

    // Stock restored to the pre-loading value.
    const after = await inventoryService(prisma).stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((after.items[0] as { stock: { toString(): string } }).stock)).toBe(30);

    // getById shows the reversal linkage; the original is immutable forever.
    const view = await loading.getById(INTEGRATION_COMPANY_ID, loadingId, { canViewDriverInfo: true });
    expect(view.status).toBe('REVERSED');
    expect(view.reversalOf).toBeNull();
    expect(view.movements.some((m: { reversalOfMovementId: string | null }) => m.reversalOfMovementId !== null)).toBe(true);
    await expect(
      loading.reverse(INTEGRATION_COMPANY_ID, loadingId, { reason: 'again' }, actor, {}),
    ).rejects.toMatchObject({ statusCode: 409, message: 'LOADING_NOT_REVERSIBLE' });
    await expect(
      loading.update(INTEGRATION_COMPANY_ID, loadingId, { notes: 'x' } as never, actor, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: 'LOADING_NOT_DRAFT' });
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { id: receiptId } } });
    await prisma.goodsReceipt.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: receiptId } }).catch(() => undefined);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId, customerId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
