import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';
import { LoadingService } from './loading.service';
import { InventoryService } from '../inventory/inventory.service';
import { ApprovalRequestService } from '../approvals/approvals.service';
import { NotificationService } from '../notifications/notifications.service';
import { QueueService } from '../queue/queue.service';
import { QueueHandlerRegistry } from '../queue/queue.handlers';
import { loadingService, mainWarehouse, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-13 audit-atomicity: the CONFIRM audit row is written through the caller's
 * transaction (recordTx) — an injected audit failure rolls back the WHOLE
 * confirmation: no movements, no status change, no approval rows. The draft
 * stays intact and a retry with a healthy audit succeeds. (corr-05 pattern.)
 */
describeIntegration('p6-13 audit-atomicity', () => {
  const prisma = integrationPrisma();
  const marker = `p6-13-${Date.now()}`;
  let actorId = '';
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  /** Service wired to a SPECIFIC AuditService instance (so the spy bites). */
  function makeLoadingService(audit: AuditService): LoadingService {
    const timeline = new TimelineService(prisma as never);
    const relations = new DocumentRelationService(prisma as never, audit);
    const notifications = new NotificationService(
      prisma as never,
      new QueueService(prisma as never, new QueueHandlerRegistry(), {
        add: async () => false,
        removeJob: async () => undefined,
      } as never),
    );
    const approvals = new ApprovalRequestService(prisma as never, audit, timeline, notifications);
    return new LoadingService(
      prisma as never,
      audit,
      timeline,
      relations,
      new InventoryService(prisma as never, audit),
      approvals,
    );
  }

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    variant = await createVariant(prisma, marker);
    await mainWarehouse(prisma);
  });

  it('an audit failure on confirm leaves NOTHING behind', async () => {
    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValueOnce(new Error('audit write failed'));
    const service = makeLoadingService(audit);
    const actor = { id: actorId, username: 'admin' };

    const created = await service.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variant.variantId, actualQuantity: 7 }] },
      actor,
      {},
    );
    loadingId = created.id;

    await expect(
      service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {}),
    ).rejects.toThrow('audit write failed');

    // No status change…
    const row = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(row.status).toBe('DRAFT');
    // …no movements…
    expect(
      await prisma.stockMovement.count({ where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId } }),
    ).toBe(0);
    // …no approval request / no audit row from the failed confirm.
    expect(
      await prisma.approvalRequest.count({ where: { entityType: 'loading', entityId: loadingId } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { entityType: 'loading', entityId: loadingId, action: 'CONFIRM' } }),
    ).toBe(0);

    // Retry with a healthy audit succeeds (draft intact, reusable).
    const retry = await loadingService(prisma).confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    expect(retry.status).toBe('CONFIRMED');
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await disconnectIntegrationPrisma();
  });
});
