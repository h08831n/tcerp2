import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { inventoryService, goodsReceiptService, stockQuery, movementQuery } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  createSupplierAndCustomer,
  cleanupPartyLocations,
} from './g6-helpers';

/**
 * g6-13 — internal-transfer-preserves-total: POST /api/inventory/transfer
 * (service: inventory.edit) writes ONE INTERNAL→INTERNAL movement between
 * two warehouses. The company total is unchanged (both ends internal — 0
 * delta by construction); the per-warehouse views move in opposite
 * directions; same-warehouse transfers are rejected.
 */
describeIntegration('g6-13 internal-transfer-preserves-total', () => {
  const prisma = integrationPrisma();
  const marker = `g6-13-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let destinationWarehouseId = '';

  it('50 in MAIN; transfer 20 → MAIN 30 + W2 20; company still 50', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    customerId = parties.customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;

    const inventory = inventoryService(prisma);
    const main = await inventory.ensureDefaultWarehouse(prisma as never, INTEGRATION_COMPANY_ID);
    const w2 = await inventory.createWarehouse(
      INTEGRATION_COMPANY_ID,
      { code: `G6T-${marker}`, nameFa: 'انبار مقصد انتقال' },
      actor,
      {},
    );
    destinationWarehouseId = w2.id;

    // Baseline 50 into MAIN.
    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 50, uomId: uoms.kgId, unitPrice: 0 }] },
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
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 50, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptId = receipt.id;
    await goodsReceiptService(prisma).confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    // Same-warehouse transfer is a 422.
    await expect(
      inventory.transfer(
        INTEGRATION_COMPANY_ID,
        { variantId, quantity: 5, uomId: uoms.kgId, fromWarehouseId: main.id, toWarehouseId: main.id },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'TRANSFER_SAME_WAREHOUSE' });

    // The transfer: exactly ONE INTERNAL→INTERNAL movement.
    const result = await inventory.transfer(
      INTEGRATION_COMPANY_ID,
      { variantId, quantity: 20, uomId: uoms.kgId, fromWarehouseId: main.id, toWarehouseId: w2.id },
      actor,
      {},
    );
    expect(result.inserted).toBe(true);

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'TRANSFER' },
    });
    const mine = movements.filter((m) => m.companyId === INTEGRATION_COMPANY_ID && (m.warehouseId === main.id || m.warehouseId === w2.id));
    const mineForVariant = mine.filter((m) => m.productVariantId === variantId);
    expect(mineForVariant).toHaveLength(1);
    const mainLoc = await prisma.stockLocation.findFirstOrThrow({ where: { companyId: INTEGRATION_COMPANY_ID, code: `LOC-${main.code}` } });
    const w2Loc = await prisma.stockLocation.findFirstOrThrow({ where: { companyId: INTEGRATION_COMPANY_ID, code: `LOC-${w2.code}` } });
    expect(mineForVariant[0].sourceLocationId).toBe(mainLoc.id);
    expect(mineForVariant[0].destinationLocationId).toBe(w2Loc.id);
    expect(mineForVariant[0].direction).toBe('OUT');

    // Company total unchanged; warehouses moved apart.
    const stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(50);
    const mainStock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId, warehouseId: main.id }));
    expect(Number((mainStock.items[0] as { stock: { toString(): string } }).stock)).toBe(30);
    const w2Stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId, warehouseId: w2.id }));
    expect(Number((w2Stock.items[0] as { stock: { toString(): string } }).stock)).toBe(20);
    void customerId;
    void movementQuery;
  });

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { id: receiptId } } });
    await prisma.goodsReceipt.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: receiptId } }).catch(() => undefined);
    await cleanupPurchaseDocument(prisma, purchaseId);
    if (destinationWarehouseId) {
      await prisma.warehouse.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: destinationWarehouseId } }).catch(() => undefined);
    }
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId, customerId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
