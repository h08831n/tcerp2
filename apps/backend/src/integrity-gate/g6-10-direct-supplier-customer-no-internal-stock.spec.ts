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
  customerLocationCode,
  supplierLocationCode,
} from './g6-helpers';

/**
 * g6-10 — direct-supplier-customer-no-internal-stock: the DIRECT route moves
 * goods SUPPLIER → CUSTOMER (external endpoints, warehouseId null) and must
 * leave the company's INTERNAL stock untouched.
 */
describeIntegration('g6-10 direct-supplier-customer-no-internal-stock', () => {
  const prisma = integrationPrisma();
  const marker = `g6-10-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  it('DIRECT loading moves nothing inside the company', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    customerId = parties.customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    // Baseline: 50 kg physically in MAIN.
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

    // DIRECT trade: the loading never touches the warehouse.
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customerId,
        lines: [{ productVariantId: variantId, actualQuantity: 20 }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    expect(created.route).toBe('DIRECT_SUPPLIER_TO_CUSTOMER');
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(movement.direction).toBe('OUT');
    expect(movement.warehouseId).toBeNull();
    // No purchase allocation on the loading → the company DEFAULT supplier
    // location (per-party locations come from GRNs / purchase allocations).
    const supplierLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'SUPPLIER-DEFAULT' },
    });
    const customerLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: customerLocationCode(customerId) },
    });
    expect(movement.sourceLocationId).toBe(supplierLocation.id);
    expect(movement.destinationLocationId).toBe(customerLocation.id);

    // Internal stock is UNCHANGED (company + warehouse views).
    const inventory = inventoryService(prisma);
    const stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(50);
    const perWarehouse = await inventory.stock(
      INTEGRATION_COMPANY_ID,
      stockQuery({ variantId, warehouseId: main.id }),
    );
    expect(Number((perWarehouse.items[0] as { stock: { toString(): string } }).stock)).toBe(50);
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
