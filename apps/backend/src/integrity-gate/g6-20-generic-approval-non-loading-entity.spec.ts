import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { approvalRequestService, goodsReceiptService, mainWarehouse, cleanupGoodsReceipt } from '../testing/p6-fixtures';
import { ApprovalRequestService } from '../approvals/approvals.service';
import { createVariantEx, seededUoms, createSupplierAndCustomer, cleanupPartyLocations } from './g6-helpers';

/**
 * g6-20 — generic-approval-non-loading-entity: ApprovalRequest is GENERIC
 * (no physical FK — Integrity Gate #13). A goods_receipt-targeted request is
 * decidable through the same engine WITHOUT any loading side-effects, an
 * unknown entityType is rejected, and a decision on a missing entity cannot
 * commit.
 */
describeIntegration('g6-20 generic-approval-non-loading-entity', () => {
  const prisma = integrationPrisma();
  const marker = `g6-20-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let purchaseId = '';
  let receiptId = '';
  let approvalId = '';
  let approvals: ApprovalRequestService;

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    approvals = approvalRequestService(prisma);
  });

  it('a goods_receipt approval decides cleanly with no loading effects', async () => {
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const parties = await createSupplierAndCustomer(prisma, marker);
    supplierId = parties.supplier.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    const main = await mainWarehouse(prisma);

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variant.variantId, quantity: 5, uomId: uoms.kgId, unitPrice: 0 }] },
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
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 5, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptId = receipt.id;

    // The generic reference: (entityType='goods_receipt', entityId=GRN id).
    const approval = await prisma.approvalRequest.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'goods_receipt',
        entityId: receiptId,
        approvalType: 'RELEASE_DRIVER_INFO',
        requestedBy: actorId,
      },
    });
    approvalId = approval.id;

    const decided = await approvals.decide(
      INTEGRATION_COMPANY_ID,
      approvalId,
      { decision: 'APPROVED', note: 'تایید مدیر خرید' },
      actor,
      {},
    );
    expect(decided.status).toBe('APPROVED');
    expect(decided.decidedBy).toBe(actorId);

    // NO loading was touched (there is none) and the receipt is unchanged.
    const row = await prisma.goodsReceipt.findUniqueOrThrow({ where: { id: receiptId } });
    expect(row.status).toBe('DRAFT');

    // The loading-scoped release lookup still filters entityType='loading' —
    // a goods_receipt approval is invisible to it.
    expect(await approvals.findPendingLoadingRelease(INTEGRATION_COMPANY_ID, receiptId)).toBeNull();
  });

  it('unknown entityType / missing entity are rejected on decide', async () => {
    const actor = { id: actorId, username: 'admin' };

    // An unregistered entity type can never be decided.
    const bogusType = await prisma.approvalRequest.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'flying_carpet',
        entityId: receiptId,
        approvalType: 'RELEASE_DRIVER_INFO',
      },
    });
    await expect(
      approvals.decide(INTEGRATION_COMPANY_ID, bogusType.id, { decision: 'APPROVED' }, actor, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: 'APPROVAL_UNKNOWN_ENTITY_TYPE' });

    // A registered type pointing at a MISSING entity → 404 (no commit).
    const missingEntity = await prisma.approvalRequest.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        entityType: 'goods_receipt',
        entityId: '00000000-0000-4000-8000-0000000000f0',
        approvalType: 'RELEASE_DRIVER_INFO',
      },
    });
    await expect(
      approvals.decide(INTEGRATION_COMPANY_ID, missingEntity.id, { decision: 'APPROVED' }, actor, {}),
    ).rejects.toMatchObject({ statusCode: 404 });

    // assertEntityExists is the reusable seam for future producers.
    await expect(
      approvals.assertEntityExists(INTEGRATION_COMPANY_ID, 'goods_receipt', receiptId),
    ).resolves.toBeUndefined();
    await expect(
      approvals.assertEntityExists(INTEGRATION_COMPANY_ID, 'purchase_order', receiptId),
    ).rejects.toMatchObject({ statusCode: 422, message: 'APPROVAL_UNKNOWN_ENTITY_TYPE' });
  });

  afterAll(async () => {
    await prisma.approvalRequest.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, entityId: { in: [receiptId, '00000000-0000-4000-8000-0000000000f0'] } },
    });
    await cleanupGoodsReceipt(prisma, receiptId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: { startsWith: `G6-${marker}` } } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
