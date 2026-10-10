import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { goodsReceiptService } from '../testing/p6-fixtures';
import { NormalizationService } from '../inventory/normalization.service';
import { createVariantEx, seededUoms, createSupplierAndCustomer, cleanupPartyLocations, ensureMainWarehouse } from './g6-helpers';

/**
 * g6-15 — grn-confirm-idempotent: a double confirm is a 403
 * GOODS_RECEIPT_CONFIRMED, and a FORCED re-run of the movement insert (the
 * same `grn:{id}:line:{lineId}` key) is a no-op — the unique idempotency key
 * is the only duplicate authority, so re-confirmation can never double-count.
 */
describeIntegration('g6-15 grn-confirm-idempotent', () => {
  const prisma = integrationPrisma();
  const marker = `g6-15-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let purchaseId = '';
  let receiptId = '';

  it('double confirm → 403; forced re-run of the seam → no duplicates', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 10, uomId: uoms.kgId, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    const receipts = goodsReceiptService(prisma);
    const draft = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 10, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptId = draft.id;
    await receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    // Double confirm → 403 GOODS_RECEIPT_CONFIRMED (before any write).
    await expect(
      receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 403, message: 'GOODS_RECEIPT_CONFIRMED' });

    // FORCED re-run of the movement generation seam with the SAME key — the
    // exact shape confirm() would use on a pathological retry.
    const inserted = await prisma.$transaction(async (tx) => {
      const line = await prisma.goodsReceiptLine.findFirstOrThrow({ where: { goodsReceiptId: receiptId } });
      return new NormalizationService(prisma as never).insertStockMovement(tx, {
        companyId: INTEGRATION_COMPANY_ID,
        productVariantId: variantId,
        quantity: line.actualQuantity,
        uomId: line.uomId,
        direction: 'IN',
        sourceLocationId: (
          await prisma.stockLocation.findFirstOrThrow({ where: { companyId: INTEGRATION_COMPANY_ID, code: `SUPPLIER-${supplierId}` } })
        ).id,
        destinationLocationId: (
          await prisma.stockLocation.findFirstOrThrow({ where: { companyId: INTEGRATION_COMPANY_ID, code: `LOC-${main.code}` } })
        ).id,
        warehouseId: main.id,
        movementDate: new Date(),
        sourceEntityType: 'PURCHASE_RECEIPT',
        sourceEntityId: receiptId,
        idempotencyKey: `grn:${receiptId}:line:${line.id}`,
        createdBy: actorId,
      });
    });
    expect(inserted).toBe(false); // already there — never duplicated

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId },
    });
    expect(movements).toHaveLength(1);

    // The purchase amount was applied EXACTLY once (10 kg × 0 price → 0, but
    // the movement count is the authoritative idempotency evidence).
    const doc = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(doc.operationalLoadedAmount)).toBe(0);
    expect(doc.status).toBe('COMPLETED'); // 10 ≥ 10 — set once, not twice
  });

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { id: receiptId } } });
    await prisma.goodsReceipt.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: receiptId } }).catch(() => undefined);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
