import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId } from '../testing/p4-fixtures';
import {
  loadingService,
  inventoryService,
  goodsReceiptService,
  stockQuery,
} from '../testing/p6-fixtures';
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
 * g6-01 — 40000 kg IN (goods receipt) vs 40 ton OUT (warehouse loading)
 * compute EXACTLY 0 stock: the variant's inventory UOM is `ton`, so the kg
 * receipt normalizes to 40 ton and both movements aggregate on
 * normalizedQuantity alone. Raw units are never compared or summed.
 */
describeIntegration('g6-01 40000kg-in-vs-40ton-out-stock-0', () => {
  const prisma = integrationPrisma();
  const marker = `g6-01-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
  });

  it('40 t of stock in (as 40000 kg) minus 40 t out → 0', async () => {
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const supplierAndCustomer = await createSupplierAndCustomer(prisma, marker);
    supplierId = supplierAndCustomer.supplier.id;
    customerId = supplierAndCustomer.customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.tonId, inventoryUomId: uoms.tonId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);

    // PO: 40 ton. GRN: 40000 kg (same physical amount, different unit).
    const placed = await createPlacedPurchase(
      prisma,
      supplierId,
      [{ productVariantId: variantId, quantity: 40, uomId: uoms.tonId }],
      marker,
    );
    purchaseId = placed.purchaseId;
    const receipt = await receiveGoods(
      goodsReceiptService(prisma),
      prisma,
      purchaseId,
      [{ purchaseLineId: placed.lineIds[0], actualQuantity: 40000, uomId: uoms.kgId }],
      { warehouseId: main.id, marker },
    );
    receiptId = receipt.receiptId;

    // The movement keeps BOTH pairs verbatim: source 40000 kg → normalized 40 ton.
    const inMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId },
    });
    expect(Number(inMovement.sourceQuantity)).toBe(40000);
    expect(inMovement.sourceUomId).toBe(uoms.kgId);
    expect(Number(inMovement.normalizedQuantity)).toBe(40);
    expect(inMovement.inventoryUomId).toBe(uoms.tonId);

    // OUT 40 ton (warehouse → customer loading).
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        customerPartyId: customerId,
        lines: [{ productVariantId: variantId, actualQuantity: 40, uomId: uoms.tonId }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const outMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(Number(outMovement.normalizedQuantity)).toBe(40);
    expect(outMovement.inventoryUomId).toBe(uoms.tonId);

    // Stock: +40 t − 40 t = 0 (per variant AND per warehouse).
    const inventory = inventoryService(prisma);
    const stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(stock.total).toBe(1);
    const row = stock.items[0] as { stock: { toString(): string }; negative: boolean };
    expect(Number(row.stock)).toBe(0);
    expect(row.negative).toBe(false);

    const perWarehouse = await inventory.stock(
      INTEGRATION_COMPANY_ID,
      stockQuery({ variantId, warehouseId: main.id }),
    );
    expect(Number((perWarehouse.items[0] as { stock: { toString(): string } }).stock)).toBe(0);
  });

  afterAll(async () => {
    await cleanupReceiptAndPurchase(prisma, receiptId, purchaseId);
    if (loadingId) {
      // Remove the loading row (movements already removed with the receipt).
      await prisma.loadingLine.deleteMany({ where: { loadingId } }).catch(() => undefined);
      await prisma.loading.deleteMany({ where: { id: loadingId } }).catch(() => undefined);
    }
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId, customerId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
