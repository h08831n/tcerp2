import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId } from '../testing/p4-fixtures';
import { inventoryService, goodsReceiptService, movementQuery, stockQuery } from '../testing/p6-fixtures';
import {
  createPlacedPurchase,
  createSupplierAndCustomer,
  createVariantEx,
  receiveGoods,
  cleanupReceiptAndPurchase,
  cleanupPartyLocations,
  ensureMainWarehouse,
  seededUoms,
} from './g6-helpers';

/**
 * g6-02 — raw-units-never-summed: two receipts entered in DIFFERENT units
 * (1000 kg + 500 kg) for one ton-based variant aggregate to 1.5 ton — the
 * stock query sums ONLY normalizedQuantity. The movement ledger exposes both
 * pairs (verbatim source kg / normalized ton) so no viewer needs to guess.
 */
describeIntegration('g6-02 raw-units-never-summed', () => {
  const prisma = integrationPrisma();
  const marker = `g6-02-${Date.now()}`;
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  const receiptIds: string[] = [];

  it('1000 kg + 500 kg receipts → 1.5 t of stock, ledger keeps both pairs', async () => {
    const actor = { id: await adminUserId(prisma), username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    customerId = parties.customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.tonId, inventoryUomId: uoms.tonId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    const placed = await createPlacedPurchase(
      prisma,
      supplierId,
      [{ productVariantId: variantId, quantity: 2, uomId: uoms.tonId }],
      marker,
    );
    purchaseId = placed.purchaseId;

    // 1000 kg then 500 kg — over-receipt deliberately allowed (cumulative
    // 1.5 t vs the 2 t ordered is fine).
    const receipts = goodsReceiptService(prisma);
    const r1 = await receiveGoods(
      receipts,
      prisma,
      purchaseId,
      [{ purchaseLineId: placed.lineIds[0], actualQuantity: 1000, uomId: uoms.kgId }],
      { warehouseId: main.id, marker },
    );
    const r2 = await receiveGoods(
      receipts,
      prisma,
      purchaseId,
      [{ purchaseLineId: placed.lineIds[0], actualQuantity: 500, uomId: uoms.kgId }],
      { warehouseId: main.id, marker },
    );
    receiptIds.push(r1.receiptId, r2.receiptId);

    const inventory = inventoryService(prisma);
    const stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    // 1.5 ton — NOT 1500 or 150000 (raw sums are impossible by construction).
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(1.5);

    const ledger = await inventory.movements(INTEGRATION_COMPANY_ID, movementQuery({ variantId }));
    const items = ledger.items as {
      source: { quantity: { toString(): string }; uom: { id: string } };
      normalized: { quantity: { toString(): string }; uom: { id: string } };
    }[];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.source.uom.id).toBe(uoms.kgId); // verbatim source pair
      expect(item.normalized.uom.id).toBe(uoms.tonId); // inventory pair
      expect(item.normalized.uom.id).not.toBe(item.source.uom.id);
    }
    const normalized = items.map((i) => Number(i.normalized.quantity)).sort((a, b) => b - a);
    expect(normalized).toEqual([1, 0.5]);
    void customerId;
  });

  afterAll(async () => {
    for (const id of receiptIds) await cleanupReceiptAndPurchase(prisma, id, '');
    await cleanupReceiptAndPurchase(prisma, '', purchaseId);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId, customerId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
