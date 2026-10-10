import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { loadingService, inventoryService, goodsReceiptService, stockQuery } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  ensureMainWarehouse,
  createSupplierAndCustomer,
  cleanupPartyLocations,
} from './g6-helpers';

/**
 * g6-05 — piece-to-kg-via-weight-per-unit: the ONLY cross-category bridge is
 * the variant's product-weight pair. 100 pieces × 18.7 kg/piece = 1870 kg
 * normalized on the receipt; a 1 ton warehouse loading drains 1000 kg; the
 * remainder reads 870 kg — all Decimal-exact, never float.
 */
describeIntegration('g6-05 piece-to-kg-via-weight-per-unit', () => {
  const prisma = integrationPrisma();
  const marker = `g6-05-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let customerId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  it('100 pcs in → 1870 kg; 1 t out → 870 kg left', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    customerId = parties.customer.id;
    const main = await ensureMainWarehouse(prisma);

    // pcs default uom; kg inventory uom; 18.7 kg per piece.
    const variant = await createVariantEx(prisma, marker, {
      defaultUomId: uoms.pcsId,
      inventoryUomId: uoms.kgId,
      weightPerUnit: '18.7',
      weightUomId: uoms.kgId,
    });
    variantId = variant.variantId;

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 200, uomId: uoms.pcsId, unitPrice: 0 }] },
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
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 100, uomId: uoms.pcsId }],
      },
      actor,
      {},
    );
    receiptId = receipt.id;
    await goodsReceiptService(prisma).confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    const inMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId },
    });
    expect(Number(inMovement.sourceQuantity)).toBe(100);
    expect(inMovement.sourceUomId).toBe(uoms.pcsId);
    expect(Number(inMovement.normalizedQuantity)).toBe(1870); // 100 × 18.7
    expect(inMovement.inventoryUomId).toBe(uoms.kgId);

    // OUT 1 ton (weight category — same-category ratio into the kg inventory uom).
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        customerPartyId: customerId,
        lines: [{ productVariantId: variantId, actualQuantity: 1, uomId: uoms.tonId }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const outMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(Number(outMovement.normalizedQuantity)).toBe(1000);

    const stock = await inventoryService(prisma).stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(870);
  });

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { id: receiptId } } });
    await prisma.goodsReceipt.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: receiptId } }).catch(() => undefined);
    await cleanupPurchaseDocument(prisma, purchaseId);
    if (loadingId) {
      await prisma.loadingLine.deleteMany({ where: { loadingId } }).catch(() => undefined);
      await prisma.loading.deleteMany({ where: { id: loadingId } }).catch(() => undefined);
    }
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId, customerId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
