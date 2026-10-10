import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import {
  goodsReceiptService,
  loadingService,
  cleanupLoading,
  cleanupGoodsReceipt,
} from '../testing/p6-fixtures';
import { NormalizationService } from '../inventory/normalization.service';
import {
  createVariantEx,
  seededUoms,
  createSupplierAndCustomer,
  cleanupPartyLocations,
  ensureMainWarehouse,
} from '../integrity-gate/g6-helpers';

/**
 * g6f-03 — cost-snapshot-immutability (final correction #3): the movement
 * write seam persists unitCostSnapshot / totalCostSnapshot (totalCost =
 * normalizedQuantity × unitCost, computed BY the writer):
 *   - GRN of 1 t priced 100/t against an inventory UOM of kg → unitCost
 *     0.1/kg (100 ÷ 1000, the per-UOM conversion) and totalCost 100;
 *   - the direct loading's OUT movement carries the SAME PO-line cost
 *     (500 kg → 50); a line WITHOUT a purchase allocation gets no cost;
 *   - confirm → reverse → forced re-confirm: the original movement rows stay
 *     byte-identical (append-only history) while the compensating rows carry
 *     the original's unitCost with the NEGATED totalCost.
 */
describeIntegration('g6f-03 cost-snapshot-immutability', () => {
  const prisma = integrationPrisma();
  const marker = `g6f-03-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';

  it('GRN + loading cost snapshots, reversal chain leaves originals untouched', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    // PO priced per TON, inventory UOM = KG: 1 t = 1000 kg → 100/t = 0.1/kg.
    const variant = await createVariantEx(prisma, marker, {
      defaultUomId: uoms.tonId,
      inventoryUomId: uoms.kgId,
    });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplierId,
        lines: [{ productVariantId: variantId, quantity: 2, uomId: uoms.tonId, unitPrice: 100 }],
      },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    // GRN 1 t → movement 1000 kg @ unitCost 0.1 → totalCost 100.
    const receipts = goodsReceiptService(prisma);
    const draft = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 1, uomId: uoms.tonId }],
      },
      actor,
      {},
    );
    receiptId = draft.id;
    await receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    const grnMovement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId },
    });
    expect(grnMovement.normalizedQuantity.toString()).toBe('1000');
    expect(Number(grnMovement.unitCostSnapshot)).toBe(0.1);
    expect(Number(grnMovement.totalCostSnapshot)).toBe(100);

    // The fulfillment ledger amount equals the movement's totalCost.
    let doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(100);
    expect(doc.status).toBe('PARTIALLY_LOADED');

    // Direct loading: 500 kg WITH the purchase allocation + 250 kg without.
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'DIRECT_SUPPLIER_TO_CUSTOMER',
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 500,
            uomId: uoms.kgId,
            allocations: [{ purchaseLineId: po.lines[0].id, allocatedQuantity: 500 }],
          },
          { productVariantId: variantId, actualQuantity: 250, uomId: uoms.kgId },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const loadingMovements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
      orderBy: { idempotencyKey: 'asc' },
    });
    expect(loadingMovements).toHaveLength(2);
    // Identify the allocated line by its loading line (the movement key is
    // `loading:{loadingId}:line:{lineId}` — the line ids are random UUIDs, so
    // the key order is NOT deterministic).
    const loadingLines = await prisma.loadingLine.findMany({
      where: { loadingId },
      select: { id: true, allocations: { select: { id: true } } },
    });
    const allocatedLineId = loadingLines.find((l) => l.allocations.length > 0)!.id;
    const withCost = loadingMovements.find((m) => m.idempotencyKey.endsWith(`line:${allocatedLineId}`))!;
    const withoutCost = loadingMovements.find((m) => m.id !== withCost.id)!;
    expect(withCost.direction).toBe('OUT');
    expect(Number(withCost.unitCostSnapshot)).toBe(0.1); // same PO-linked cost as the receipt
    expect(Number(withCost.totalCostSnapshot)).toBe(50); // 500 kg × 0.1
    expect(withoutCost.unitCostSnapshot).toBeNull(); // no purchase allocation → no cost
    expect(withoutCost.totalCostSnapshot).toBeNull();

    doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(150); // 100 (GRN) + 50 (direct)
    expect(doc.status).toBe('PARTIALLY_LOADED');

    // ── Reversal chain: originals must stay byte-identical ──
    const originalIds = [grnMovement.id, withCost.id, withoutCost.id];
    const snapshotOriginals = async (): Promise<Map<string, string>> => {
      const rows = await prisma.stockMovement.findMany({ where: { id: { in: originalIds } } });
      return new Map(rows.map((r) => [r.id, JSON.stringify(r)]));
    };
    const before = await snapshotOriginals();

    await loading.reverse(INTEGRATION_COMPANY_ID, loadingId, { reason: 'g6f-03 بارگیری اشتباه' }, actor, {});
    doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(100); // the direct-loading ledger row flipped reversedAt
    expect(doc.status).toBe('PARTIALLY_LOADED'); // the GRN still fulfills 1 of 2 t

    await receipts.reverse(INTEGRATION_COMPANY_ID, receiptId, { reason: 'g6f-03 رسید اشتباه' }, actor, {});
    doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(0);
    expect(doc.status).toBe('ORDER_PLACED');

    // Compensating movements: original's unitCost, NEGATED totalCost.
    const loadingReversals = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING_REVERSAL', sourceEntityId: loadingId },
    });
    expect(loadingReversals).toHaveLength(2);
    const withCostReversal = loadingReversals.find((m) => m.reversalOfMovementId === withCost.id)!;
    expect(withCostReversal.direction).toBe('IN');
    expect(Number(withCostReversal.unitCostSnapshot)).toBe(0.1);
    expect(Number(withCostReversal.totalCostSnapshot)).toBe(-50);
    const withoutCostReversal = loadingReversals.find((m) => m.reversalOfMovementId === withoutCost.id)!;
    expect(withoutCostReversal.unitCostSnapshot).toBeNull();
    expect(withoutCostReversal.totalCostSnapshot).toBeNull();

    const receiptReversal = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'RECEIPT_REVERSAL', sourceEntityId: receiptId },
    });
    expect(receiptReversal.direction).toBe('OUT');
    expect(receiptReversal.reversalOfMovementId).toBe(grnMovement.id);
    expect(Number(receiptReversal.unitCostSnapshot)).toBe(0.1);
    expect(Number(receiptReversal.totalCostSnapshot)).toBe(-100);

    // Original rows byte-identical after both reversals…
    let after = await snapshotOriginals();
    for (const [id, json] of before) {
      expect(after.get(id)).toBe(json);
    }

    // …and after a FORCED re-confirm (same idempotency keys + cost args): the
    // seam is a no-op (ON CONFLICT DO NOTHING) — rows never rewritten.
    const grnLine = await prisma.goodsReceiptLine.findFirstOrThrow({ where: { goodsReceiptId: receiptId } });
    const inserted = await prisma.$transaction(async (tx) => {
      return new NormalizationService(prisma as never).insertStockMovement(tx, {
        companyId: INTEGRATION_COMPANY_ID,
        productVariantId: variantId,
        quantity: grnLine.actualQuantity,
        uomId: grnLine.uomId,
        direction: 'IN',
        sourceLocationId: grnMovement.sourceLocationId,
        destinationLocationId: grnMovement.destinationLocationId,
        warehouseId: grnMovement.warehouseId,
        movementDate: grnMovement.movementDate,
        sourceEntityType: 'PURCHASE_RECEIPT',
        sourceEntityId: receiptId,
        idempotencyKey: grnMovement.idempotencyKey,
        createdBy: actorId,
        unitCostSnapshot: grnMovement.unitCostSnapshot,
      });
    });
    expect(inserted).toBe(false);
    after = await snapshotOriginals();
    for (const [id, json] of before) {
      expect(after.get(id)).toBe(json);
    }

    // The fulfillment ledger rows are history too (never deleted by reversal).
    const ledger = await prisma.purchaseLineFulfillment.findMany({
      where: { purchaseLineId: po.lines[0].id },
    });
    expect(ledger).toHaveLength(2);
    expect(ledger.every((r) => r.reversedAt !== null)).toBe(true);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await cleanupGoodsReceipt(prisma, receiptId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
