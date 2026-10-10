import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, createVariant, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import {
  goodsReceiptService,
  inventoryService,
  mainWarehouse,
  cleanupGoodsReceipt,
  goodsReceiptQuery,
} from '../testing/p6-fixtures';

/**
 * p6-03 goods-receipt-generates-in-movements (was: purchase receive): the
 * blind PO-receive is DEPRECATED (403 RECEIVE_DEPRECATED) — real stock comes
 * from goods receipts. Confirming a GRN generates one IN movement per line
 * SUPPLIER(po supplier) → INTERNAL(default warehouse) with the
 * `grn:{id}:line:{lineId}` idempotency keys; a double confirm is rejected
 * without duplicates.
 */
describeIntegration('p6-03 goods-receipt-generates-in-movements', () => {
  const prisma = integrationPrisma();
  const marker = `p6-03-${Date.now()}`;
  let actorId = '';
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let purchaseId = '';
  let receiptId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplier = await createParty(prisma, ['SUPPLIER'], marker);
    variant = await createVariant(prisma, marker);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);
    await mainWarehouse(prisma);
  });

  it('PO receive is deprecated; GRN confirm → IN movements; double confirm → no duplicates', async () => {
    const purchase = purchaseService(prisma);
    const receipts = goodsReceiptService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const created = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [
          { productVariantId: variant.variantId, quantity: 10, unitPrice: 5000 },
          { productVariantId: variant.variantId, quantity: 5, unitPrice: 5000 },
        ],
      },
      actor,
      {},
    );
    purchaseId = created.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    // The blind receive tombstone: stable 403, never a silent stock write.
    await expect(
      purchase.receive(INTEGRATION_COMPANY_ID, purchaseId),
    ).rejects.toMatchObject({ statusCode: 403, message: 'RECEIVE_DEPRECATED' });
    expect(
      await prisma.stockMovement.count({ where: { sourceEntityType: 'PURCHASE', sourceEntityId: purchaseId } }),
    ).toBe(0);

    // The REAL receipt: DRAFT → confirm.
    const draft = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        lines: [
          { purchaseLineId: created.lines[0].id, actualQuantity: 10, uomId: variant.uomId },
          { purchaseLineId: created.lines[1].id, actualQuantity: 5, uomId: variant.uomId },
        ],
      },
      actor,
      {},
    );
    receiptId = draft.id;
    expect(draft.status).toBe('DRAFT');
    expect(draft.receiptNumber).toMatch(/^GRN-/);

    const confirmed = await receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});
    expect(confirmed.status).toBe('CONFIRMED');

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId },
    });
    expect(movements).toHaveLength(2);
    const lineIds = [draft.lines[0].id, draft.lines[1].id];
    const main = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'MAIN' },
    });
    const supplierLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `SUPPLIER-${supplier.id}` },
    });
    const internalLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `LOC-${main.code}` },
    });
    movements.forEach((movement) => {
      expect(movement.direction).toBe('IN');
      expect(lineIds).toContain(movement.idempotencyKey.replace(`grn:${receiptId}:line:`, ''));
      expect(movement.sourceEntityType).toBe('PURCHASE_RECEIPT');
      expect(movement.companyId).toBe(INTEGRATION_COMPANY_ID);
      expect(movement.sourceLocationId).toBe(supplierLocation.id);
      expect(movement.destinationLocationId).toBe(internalLocation.id);
      expect(movement.warehouseId).toBe(main.id);
    });

    // Double confirm: rejected, no duplicates.
    await expect(
      receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 403, message: 'GOODS_RECEIPT_CONFIRMED' });
    expect(
      await prisma.stockMovement.count({ where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId } }),
    ).toBe(2);

    // The receipt is audited + listed.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'goods_receipt', entityId: receiptId, action: 'CONFIRM' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const list = await receipts.list(INTEGRATION_COMPANY_ID, goodsReceiptQuery({ status: 'CONFIRMED' }));
    expect((list.items as { id: string }[]).some((r) => r.id === receiptId)).toBe(true);
  });

  afterAll(async () => {
    await cleanupGoodsReceipt(prisma, receiptId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    const parties = await prisma.party.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: marker } },
      select: { id: true },
    });
    await prisma.stockLocation.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, partyId: { in: parties.map((p) => p.id) } },
    });
    await prisma.party.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, id: { in: parties.map((p) => p.id) } },
    });
    await disconnectIntegrationPrisma();
  });
});
