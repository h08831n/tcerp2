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
  ensureMainWarehouse,
  createSupplierAndCustomer,
  cleanupPartyLocations,
} from './g6-helpers';

/**
 * g6-12 — warehouse-customer-decreases-internal: the WAREHOUSE_TO_CUSTOMER
 * route ships FROM the warehouse: one OUT movement INTERNAL → CUSTOMER,
 * −quantity on the company total and on the warehouse's outbound legs.
 */
describeIntegration('g6-12 warehouse-customer-decreases-internal', () => {
  const prisma = integrationPrisma();
  const marker = `g6-12-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  it('WAREHOUSE_TO_CUSTOMER confirm → OUT movement, internal stock down', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    customerId = parties.customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    // Baseline 30 kg in MAIN.
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

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(movement.direction).toBe('OUT');
    expect(movement.warehouseId).toBe(main.id);
    const internal = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `LOC-${main.code}` },
    });
    const customerLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `CUSTOMER-${customerId}` },
    });
    expect(movement.sourceLocationId).toBe(internal.id);
    expect(movement.destinationLocationId).toBe(customerLocation.id);

    const inventory = inventoryService(prisma);
    const stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(18);
    const perWarehouse = await inventory.stock(
      INTEGRATION_COMPANY_ID,
      stockQuery({ variantId, warehouseId: main.id }),
    );
    expect(Number((perWarehouse.items[0] as { stock: { toString(): string } }).stock)).toBe(18);
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
