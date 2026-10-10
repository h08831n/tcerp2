import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { inventoryService, goodsReceiptService, goodsReceiptQuery, stockQuery } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  createSupplierAndCustomer,
  cleanupPartyLocations,
  ensureMainWarehouse,
} from './g6-helpers';

/**
 * g6-14 — partial-grn-30-35-36-against-100: three receipts of 30, 35 and 36
 * against a PO line of 100 — over-receipt is ALLOWED (never blocked) and the
 * third receipt's line is flagged `overReceipt: true` (cumulative 101 > 100).
 * The purchase operational amount and status follow the ACTUAL quantities.
 */
describeIntegration('g6-14 partial-grn-30-35-36-against-100', () => {
  const prisma = integrationPrisma();
  const marker = `g6-14-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let purchaseId = '';
  let mainId = '';
  const receiptIds: string[] = [];

  it('30 + 35 confirmed, 36 flags overReceipt and completes the PO at 101', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);
    mainId = main.id;

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 100, uomId: uoms.kgId, unitPrice: 10 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    const receipts = goodsReceiptService(prisma);

    // Receipt #1: 30 → PARTIALLY_LOADED, amount 300, not over.
    const r1 = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 30, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptIds.push(r1.id);
    await receipts.confirm(INTEGRATION_COMPANY_ID, r1.id, actor, {});
    expect((r1.lines[0] as { overReceipt: boolean }).overReceipt).toBe(false);
    let doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(300);
    expect(doc.status).toBe('PARTIALLY_LOADED');

    // Receipt #2: 35 → cumulative 65, still PARTIALLY_LOADED.
    const r2 = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 35, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptIds.push(r2.id);
    await receipts.confirm(INTEGRATION_COMPANY_ID, r2.id, actor, {});
    doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(650);
    expect(doc.status).toBe('PARTIALLY_LOADED');

    // Receipt #3: 36 → cumulative 101 > 100 — allowed and FLAGGED.
    const r3 = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 36, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptIds.push(r3.id);
    const confirmed3 = await receipts.confirm(INTEGRATION_COMPANY_ID, r3.id, actor, {});
    expect((confirmed3.lines[0] as { overReceipt: boolean }).overReceipt).toBe(true);

    doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(1010); // 101 kg × 10
    expect(doc.status).toBe('COMPLETED'); // 101 ≥ 100 — fully received

    // Detail of the third receipt carries the derived flag + the movements.
    const detail = await receipts.getById(INTEGRATION_COMPANY_ID, r3.id);
    expect((detail.lines[0] as { overReceipt: boolean }).overReceipt).toBe(true);
    expect(detail.movements).toHaveLength(1);

    // The earlier receipts are NOT flagged (their cumulative was ≤ 100).
    const detail1 = await receipts.getById(INTEGRATION_COMPANY_ID, r1.id);
    expect((detail1.lines[0] as { overReceipt: boolean }).overReceipt).toBe(false);

    // Stock: 30 + 35 + 36 = 101 in the warehouse.
    const stock = await inventoryService(prisma).stock(
      INTEGRATION_COMPANY_ID,
      stockQuery({ variantId, warehouseId: mainId }),
    );
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(101);
  });

  it('the receipts are listed with their GRN numbers', async () => {
    const receipts = goodsReceiptService(prisma);
    const list = await receipts.list(INTEGRATION_COMPANY_ID, goodsReceiptQuery({ purchaseDocumentId: purchaseId }));
    expect(list.total).toBe(3);
    const numbers = (list.items as { receiptNumber: string }[]).map((r) => r.receiptNumber);
    expect(numbers.every((n) => n.startsWith('GRN-'))).toBe(true);
  });

  afterAll(async () => {
    for (const id of receiptIds) {
      await prisma.stockMovement.deleteMany({ where: { sourceEntityId: id } });
      await prisma.documentRelation.deleteMany({
        where: { OR: [{ fromType: 'goods_receipt', fromId: id }, { toType: 'goods_receipt', toId: id }] },
      });
      await prisma.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: id } });
      await prisma.goodsReceipt.deleteMany({ where: { id } }).catch(() => undefined);
    }
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
