import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { goodsReceiptService, cleanupGoodsReceipt } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  createSupplierAndCustomer,
  cleanupPartyLocations,
  ensureMainWarehouse,
} from '../integrity-gate/g6-helpers';

/**
 * g6f-02 — over-receipt-reporting (final correction #2): every GRN confirm
 * persists the per-line ordered / received / overReceived SNAPSHOTS in the
 * receipt line's uom (30 + 35 + 36 against 100 → the third receipt's snapshot
 * reads overReceived=1). The fulfillment endpoint's received total matches,
 * and the snapshots survive later recalculations (reversing receipt #2 drops
 * the OPERATIONAL received to 66 while receipt #3's snapshots stay 101/100/1
 * — immutable history).
 */
describeIntegration('g6f-02 over-receipt-reporting', () => {
  const prisma = integrationPrisma();
  const marker = `g6f-02-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let purchaseId = '';
  const receiptIds: string[] = [];

  interface Snapshots {
    orderedQuantitySnapshot: { toString(): string } | null;
    receivedQuantitySnapshot: { toString(): string } | null;
    overReceivedSnapshot: { toString(): string } | null;
  }
  const snapshotsOf = async (receiptId: string): Promise<Snapshots> => {
    const detail = await goodsReceiptService(prisma).getById(INTEGRATION_COMPANY_ID, receiptId);
    const line = (detail.lines as Snapshots[])[0];
    return line;
  };

  it('30+35+36 against 100 → third receipt snapshots 100/101/1, endpoint matches, snapshots immutable', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    const variant = await createVariantEx(prisma, marker, {
      defaultUomId: uoms.kgId,
      inventoryUomId: uoms.kgId,
    });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplierId,
        lines: [{ productVariantId: variantId, quantity: 100, uomId: uoms.kgId, unitPrice: 10 }],
      },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    const receipts = goodsReceiptService(prisma);

    const confirm = async (quantity: number): Promise<string> => {
      const draft = await receipts.create(
        INTEGRATION_COMPANY_ID,
        {
          purchaseDocumentId: purchaseId,
          warehouseId: main.id,
          lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: quantity, uomId: uoms.kgId }],
        },
        actor,
        {},
      );
      receiptIds.push(draft.id);
      await receipts.confirm(INTEGRATION_COMPANY_ID, draft.id, actor, {});
      return draft.id;
    };

    // Receipt #1: 30 — ordered 100, received 30, over 0.
    const r1 = await confirm(30);
    let snap = await snapshotsOf(r1);
    expect(Number(snap.orderedQuantitySnapshot)).toBe(100);
    expect(Number(snap.receivedQuantitySnapshot)).toBe(30);
    expect(Number(snap.overReceivedSnapshot)).toBe(0);

    // Receipt #2: 35 — cumulative 65, still under.
    const r2 = await confirm(35);
    snap = await snapshotsOf(r2);
    expect(Number(snap.receivedQuantitySnapshot)).toBe(65);
    expect(Number(snap.overReceivedSnapshot)).toBe(0);

    // Receipt #3: 36 — cumulative 101 > 100 → overReceivedSnapshot = 1.
    const r3 = await confirm(36);
    snap = await snapshotsOf(r3);
    expect(Number(snap.orderedQuantitySnapshot)).toBe(100);
    expect(Number(snap.receivedQuantitySnapshot)).toBe(101);
    expect(Number(snap.overReceivedSnapshot)).toBe(1);

    // The fulfillment endpoint's received total matches the ledger (101).
    interface FulfillmentLineView {
      receivedQty: { toString(): string };
      overReceivedQuantity?: { toString(): string };
      receivedAmount: { toString(): string };
    }
    let report = await purchase.fulfillment(INTEGRATION_COMPANY_ID, purchaseId);
    let line = (report.lines as FulfillmentLineView[])[0];
    expect(Number(line.receivedQty)).toBe(101);
    expect(Number(line.overReceivedQuantity)).toBe(1);
    expect(Number(line.receivedAmount)).toBe(1010);

    // Reversing receipt #2 recalculates the OPERATIONAL state (66 = 30 + 36)
    // but receipt #3's persisted snapshots are IMMUTABLE history.
    await receipts.reverse(INTEGRATION_COMPANY_ID, r2, { reason: 'g6f-02 خطای ثبت' }, actor, {});
    report = await purchase.fulfillment(INTEGRATION_COMPANY_ID, purchaseId);
    line = (report.lines as FulfillmentLineView[])[0];
    expect(Number(line.receivedQty)).toBe(66);
    expect(Number(line.receivedAmount)).toBe(660);

    snap = await snapshotsOf(r3);
    expect(Number(snap.orderedQuantitySnapshot)).toBe(100);
    expect(Number(snap.receivedQuantitySnapshot)).toBe(101);
    expect(Number(snap.overReceivedSnapshot)).toBe(1);
    // The earlier receipts keep their own as-of-confirm snapshots too.
    const snap1 = await snapshotsOf(r1);
    expect(Number(snap1.receivedQuantitySnapshot)).toBe(30);

    // The reversed receipt's ledger row survives with reversedAt set.
    const ledger = await prisma.purchaseLineFulfillment.findMany({
      where: { purchaseLineId: po.lines[0].id, type: 'GOODS_RECEIPT' },
    });
    expect(ledger).toHaveLength(3);
    const reversedRow = ledger.find((r) => r.sourceId === r2)!;
    expect(reversedRow.reversedAt).not.toBeNull();
    expect(ledger.filter((r) => r.reversedAt === null)).toHaveLength(2);

    const doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(660);
    expect(doc.status).toBe('PARTIALLY_LOADED');
  });

  afterAll(async () => {
    for (const id of receiptIds) await cleanupGoodsReceipt(prisma, id);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
