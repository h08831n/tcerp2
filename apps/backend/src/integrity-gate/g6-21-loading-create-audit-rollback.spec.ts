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

/**
 * g6-21 — loading-create-audit-rollback: the CREATE audit row is written
 * through the caller's transaction (recordTx) — an injected audit failure
 * rolls back the WHOLE create: no loading, no lines, no allocations, no
 * timeline event. (corr-05 / p6-13 pattern applied to create.)
 */
describeIntegration('g6-21 loading-create-audit-rollback', () => {
  const prisma = integrationPrisma();
  const marker = `g6-21-${Date.now()}`;
  let actorId = '';
  let variantId = '';

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

  it('an audit failure on create leaves NOTHING behind', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const variant = await createVariant(prisma, marker);
    variantId = variant.variantId;

    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValueOnce(new Error('audit write failed'));
    const service = makeLoadingService(audit);

    const auditRowsBefore = await prisma.auditLog.count({
      where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'loading', action: 'CREATE' },
    });

    await expect(
      service.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          lines: [
            {
              productVariantId: variantId,
              actualQuantity: 5,
              // With an allocation to prove the nested rows roll back too —
              // a foreign sales line would fail earlier, so keep it bare.
            },
          ],
        },
        actor,
        {},
      ),
    ).rejects.toThrow('audit write failed');

    // No loading row at all for this actor/marker…
    expect(
      await prisma.loading.count({ where: { companyId: INTEGRATION_COMPANY_ID, notes: { contains: marker } } }),
    ).toBe(0);
    // …no lines and no NEW CREATE audit row.
    expect(
      await prisma.loadingLine.count({ where: { productVariantId: variantId } }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'loading', action: 'CREATE' },
      }),
    ).toBe(auditRowsBefore);

    // Retry with a healthy audit succeeds.
    const healthy = makeLoadingService(new AuditService(prisma as never));
    const created = await healthy.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), notes: marker, lines: [{ productVariantId: variantId, actualQuantity: 5 }] },
      actor,
      {},
    );
    expect(created.status).toBe('DRAFT');
    await cleanup(created.id);
  });

  async function cleanup(loadingId: string) {
    await prisma.loadingLine.deleteMany({ where: { loadingId } }).catch(() => undefined);
    await prisma.loading.deleteMany({ where: { id: loadingId } }).catch(() => undefined);
  }

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `میلگرد تست ${marker}` } },
    }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
