import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { goodsReceiptService, loadingService, cleanupLoading } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  createSupplierAndCustomer,
  cleanupPartyLocations,
  ensureMainWarehouse,
} from '../integrity-gate/g6-helpers';

/**
 * g6f-01 — purchase-100t-grn-60t-direct-loading-40t-fulfilled-100 (final
 * correction #1): a PO of 100 t is fulfilled by a 60 t goods receipt AND a
 * 40 t direct (supplier→customer) loading allocated in kg — the fulfillment
 * ledger keeps BOTH contributions as separate rows, GET
 * /api/purchase/:id/fulfillment shows received=60 / directLoaded=40 /
 * fulfilled=100, the operational amount is the ledger sum
 * (60 × price + 40 × price, exact Decimal) and the document completes.
 */
describeIntegration('g6f-01 purchase-100t-grn-60t-direct-loading-40t-fulfilled-100', () => {
  const prisma = integrationPrisma();
  const marker = `g6f-01-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  it('60 t received + 40 t direct-loaded (allocated in kg) → fulfilled 100, COMPLETED', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    const variant = await createVariantEx(prisma, marker, {
      defaultUomId: uoms.tonId,
      inventoryUomId: uoms.tonId,
    });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplierId,
        lines: [{ productVariantId: variantId, quantity: 100, uomId: uoms.tonId, unitPrice: 100 }],
      },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    // GRN: 60 t → PARTIALLY_LOADED, ledger amount 60 × 100 = 6000.
    const receipts = goodsReceiptService(prisma);
    const draft = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 60, uomId: uoms.tonId }],
      },
      actor,
      {},
    );
    receiptId = draft.id;
    await receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    let doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(6000);
    expect(doc.status).toBe('PARTIALLY_LOADED');

    // Direct loading: 40 t allocated as 40000 kg on the SAME purchase line.
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'DIRECT_SUPPLIER_TO_CUSTOMER',
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 40000,
            uomId: uoms.kgId,
            allocations: [{ purchaseLineId: po.lines[0].id, allocatedQuantity: 40000 }],
          },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    // 60 t × 100 + 40 t × 100 = 10000 — the LEDGER sum (exact Decimal).
    expect(Number(doc.operationalLoadedAmount)).toBe(10000);
    expect(doc.status).toBe('COMPLETED'); // 60 + 40 ≥ 100

    // The ledger holds BOTH contributions as separate rows (converted into
    // the PO line's uom, amounts = quantity × unitPrice).
    const ledger = await prisma.purchaseLineFulfillment.findMany({
      where: { purchaseLineId: po.lines[0].id },
      orderBy: { type: 'asc' },
    });
    expect(ledger).toHaveLength(2);
    const grnRow = ledger.find((r) => r.type === 'GOODS_RECEIPT')!;
    const loadingRow = ledger.find((r) => r.type === 'DIRECT_LOADING')!;
    expect(grnRow.sourceId).toBe(receiptId);
    expect(Number(grnRow.quantity)).toBe(60);
    expect(grnRow.uomId).toBe(uoms.tonId);
    expect(Number(grnRow.amount)).toBe(6000);
    expect(grnRow.reversedAt).toBeNull();
    expect(loadingRow.sourceId).toBe(loadingId);
    expect(Number(loadingRow.quantity)).toBe(40);
    expect(Number(loadingRow.amount)).toBe(4000);
    expect(loadingRow.reversedAt).toBeNull();

    // GET /api/purchase/:id/fulfillment — the report view.
    const report = await purchase.fulfillment(INTEGRATION_COMPANY_ID, purchaseId);
    const line = (report.lines as {
      receivedQty: { toString(): string };
      directLoadedQty: { toString(): string };
      fulfilledQty: { toString(): string };
      remainingQuantity: { toString(): string };
      overReceivedQuantity: { toString(): string };
      receivedAmount: { toString(): string };
      directLoadedAmount: { toString(): string };
      fulfilledAmount: { toString(): string };
    }[])[0];
    expect(Number(line.receivedQty)).toBe(60);
    expect(Number(line.directLoadedQty)).toBe(40);
    expect(Number(line.fulfilledQty)).toBe(100);
    expect(Number(line.remainingQuantity)).toBe(40); // ordered 100 − received 60
    expect(Number(line.overReceivedQuantity)).toBe(0);
    expect(Number(line.receivedAmount)).toBe(6000);
    expect(Number(line.directLoadedAmount)).toBe(4000);
    expect(Number(line.fulfilledAmount)).toBe(10000);
    expect(Number((report.totals as { fulfilledAmount: { toString(): string } }).fulfilledAmount)).toBe(10000);
    expect(Number(report.operationalLoadedAmount)).toBe(10000);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await prisma.purchaseLineFulfillment.deleteMany({ where: { type: 'GOODS_RECEIPT', sourceId: receiptId } });
    await prisma.stockMovement.deleteMany({ where: { sourceEntityType: { in: ['PURCHASE_RECEIPT', 'RECEIPT_REVERSAL'] }, sourceEntityId: receiptId } });
    await prisma.documentRelation.deleteMany({
      where: { OR: [{ fromType: 'goods_receipt', fromId: receiptId }, { toType: 'goods_receipt', toId: receiptId }] },
    });
    await prisma.goodsReceipt.deleteMany({ where: { id: receiptId } }).catch(() => undefined);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
