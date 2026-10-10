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
import { LoadingService } from '../loading/loading.service';
import { JournalService } from '../accounting/journal.service';
import { SequencesService } from '../sequences/sequences.service';
import { AccountingEventService } from '../accounting/accounting-event.service';


import { InventoryService } from '../inventory/inventory.service';
import { NormalizationService } from '../inventory/normalization.service';
import { PurchaseFulfillmentService } from '../purchase/purchase-fulfillment.service';
import { ApprovalRequestService } from '../approvals/approvals.service';
import { NotificationService } from '../notifications/notifications.service';
import { QueueService } from '../queue/queue.service';
import { QueueHandlerRegistry } from '../queue/queue.handlers';
import { cleanupLoading } from '../testing/p6-fixtures';

/**
 * g6-22 — loading-update-audit-rollback: the UPDATE audit row is written
 * through the caller's transaction — an injected audit failure rolls back the
 * WHOLE update: the header keeps its old values and REPLACED lines are
 * restored (the deleteMany + recreate inside the tx undoes).
 */
describeIntegration('g6-22 loading-update-audit-rollback', () => {
  const prisma = integrationPrisma();
  const marker = `g6-22-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let loadingId = '';
  let originalLineId = '';

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
      new NormalizationService(prisma as never),
      new PurchaseFulfillmentService(prisma as never, new NormalizationService(prisma as never)),
      new AccountingEventService(
        prisma as never,
        new JournalService(prisma as never, new SequencesService(prisma as never, new AuditService(prisma as never))),
      ),
    );
  }

  it('an audit failure on update leaves the draft EXACTLY as it was', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const variant = await createVariant(prisma, marker);
    variantId = variant.variantId;

    const healthy = makeLoadingService(new AuditService(prisma as never));
    const created = await healthy.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        notes: 'original notes',
        lines: [{ productVariantId: variantId, actualQuantity: 7 }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    originalLineId = created.lines[0].id;

    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValueOnce(new Error('audit write failed'));
    const sabotaged = makeLoadingService(audit);

    await expect(
      sabotaged.update(
        INTEGRATION_COMPANY_ID,
        loadingId,
        {
          notes: 'changed notes',
          lines: [{ productVariantId: variantId, actualQuantity: 99 }],
        },
        actor,
        {},
      ),
    ).rejects.toThrow('audit write failed');

    // The header is untouched…
    const row = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(row.notes).toBe('original notes');
    // …and the ORIGINAL line survived (the wholesale replace rolled back).
    const lines = await prisma.loadingLine.findMany({ where: { loadingId } });
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(originalLineId);
    expect(Number(lines[0].actualQuantity)).toBe(7);

    // No UPDATE audit row from the failed attempt.
    const auditRowsBefore = await prisma.auditLog.count({
      where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'loading', entityId: loadingId, action: 'UPDATE' },
    });
    expect(auditRowsBefore).toBe(0);

    // Retry with a healthy audit applies the change.
    const updated = await healthy.update(
      INTEGRATION_COMPANY_ID,
      loadingId,
      { notes: 'changed notes', lines: [{ productVariantId: variantId, actualQuantity: 99 }] },
      actor,
      {},
    );
    expect(updated.notes).toBe('changed notes');
    expect(updated.lines).toHaveLength(1);
    expect(Number((updated.lines[0] as { actualQuantity: { toString(): string } }).actualQuantity)).toBe(99);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `میلگرد تست ${marker}` } },
    }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
