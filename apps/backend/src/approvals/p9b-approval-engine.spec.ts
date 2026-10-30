import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { NotificationService } from '../notifications/notifications.service';
import { ApprovalRequestService } from './approvals.service';
import { ApprovalDecisionBus } from './approval-decision.bus';
import { makeQueueService } from '../testing/p5-fixtures';
import { TEST_INTEGRATION, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(180000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000d1', username: 'requester' };
const DECIDER = { id: '00000000-0000-4000-8000-0000000000d2', username: 'decider' };

const COMPANY = '9e9e9e9e-9e9e-4e9e-8e9e-9e9e9e9e9e9e';

/**
 * Phase 9B — generalized approval engine: generic request creation with the
 * entity registry + duplicate-pending DB guarantee, cancel authorization,
 * OWN-scope list/detail, decision history, concurrent-decide reconciliation,
 * and the Phase-6 loading release effect regression.
 */
describe('p9b-approval-engine (Phase 9B generalization)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let approvals: ApprovalRequestService;
  const userIds: string[] = [];
  const loadingIds: string[] = [];

  const cleanup = async () => {
    await prisma.approvalEvent.deleteMany({ where: { request: { companyId: COMPANY } } }).catch(() => undefined);
    await prisma.approvalRequest.deleteMany({ where: { companyId: COMPANY } }).catch(() => undefined);
    await prisma.loading.deleteMany({ where: { companyId: COMPANY } }).catch(() => undefined);
    await prisma.notification.deleteMany({ where: { companyId: COMPANY } }).catch(() => undefined);
    await prisma.queueJob.deleteMany({ where: { companyId: COMPANY } }).catch(() => undefined);
    await prisma.timelineEvent.deleteMany({ where: { companyId: COMPANY } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: COMPANY } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  };

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    prismaService = new PrismaService();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    const audit = new AuditService(prismaService);
    const timeline = new TimelineService(prismaService);
    const queue = makeQueueService(prisma);
    const notifications = new NotificationService(prismaService, queue);
    approvals = new ApprovalRequestService(prismaService, audit, timeline, notifications, new ApprovalDecisionBus());

    await cleanup();
    await prisma.company.create({ data: { id: COMPANY, nameFa: 'p9b-approvals', status: 'ACTIVE' } });
    for (const actor of [ACTOR, DECIDER]) {
      const user = await prisma.user.create({
        data: { id: actor.id, username: `p9b-ap-${actor.username}-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
      });
      userIds.push(user.id);
    }
  });

  afterAll(async () => {
    if (!prismaService) return;
    await cleanup();
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : (name: string, fn: jest.ProvidesCallback) => it.skip(name, fn);

  async function makeLoading(): Promise<string> {
    const loading = await prisma.loading.create({
      data: { companyId: COMPANY, loadingDate: new Date(), driverInfoRestricted: true },
      select: { id: true },
    });
    loadingIds.push(loading.id);
    return loading.id;
  }

  const ctx = {} as never;

  itif('a-01 generic create registers a PENDING request + history + audit; duplicate pending rejected by the DB (concurrent)', async () => {
    const loadingId = await makeLoading();
    const created = await approvals.create(
      COMPANY,
      { entityType: 'loading', entityId: loadingId, approvalType: 'RELEASE_DRIVER_INFO', reason: 'مشتری تسویه کرد' },
      ACTOR,
      ctx,
    );
    expect(created.status).toBe('PENDING');
    expect(created.source).toBe('MANUAL');
    expect(created.requestedBy).toBe(ACTOR.id);
    expect(await prisma.approvalEvent.count({ where: { requestId: created.id, kind: 'REQUESTED' } })).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { entityType: 'approval_request', entityId: created.id, action: 'APPROVAL_REQUESTED' } }),
    ).toBe(1);
    // duplicate PENDING (sequential) → 409
    await expect(
      approvals.create(
        COMPANY,
        { entityType: 'loading', entityId: loadingId, approvalType: 'RELEASE_DRIVER_INFO' },
        ACTOR, ctx,
      ),
    ).rejects.toMatchObject({ message: 'APPROVAL_PENDING_EXISTS' });
    // concurrent double-create on a SECOND loading: exactly one wins (DB partial unique)
    const loading2 = await makeLoading();
    const results = await Promise.allSettled([
      approvals.create(COMPANY, { entityType: 'loading', entityId: loading2, approvalType: 'RELEASE_DRIVER_INFO' }, ACTOR, ctx),
      approvals.create(COMPANY, { entityType: 'loading', entityId: loading2, approvalType: 'RELEASE_DRIVER_INFO' }, DECIDER, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  itif('a-02 unregistered entity types rejected (including the engine-internal workflow_instance)', async () => {
    const loadingId = await makeLoading();
    await expect(
      approvals.create(COMPANY, { entityType: 'party', entityId: loadingId, approvalType: 'X' }, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'APPROVAL_UNKNOWN_ENTITY_TYPE' });
    await expect(
      approvals.create(COMPANY, { entityType: 'workflow_instance', entityId: loadingId, approvalType: 'X' }, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'APPROVAL_UNKNOWN_ENTITY_TYPE' });
    // registered type but missing row → 404
    await expect(
      approvals.create(
        COMPANY,
        { entityType: 'loading', entityId: '00000000-0000-4000-8000-0000000000f0', approvalType: 'X' },
        ACTOR, ctx,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  itif('a-03 cancel: requester may cancel own PENDING; stranger without decide is forbidden; decided request is not cancellable', async () => {
    const loadingId = await makeLoading();
    const created = await approvals.create(
      COMPANY, { entityType: 'loading', entityId: loadingId, approvalType: 'RELEASE_DRIVER_INFO' }, ACTOR, ctx,
    );
    // stranger (no decide) cannot cancel someone else's request
    await expect(
      approvals.cancel(COMPANY, created.id, DECIDER, false, ctx),
    ).rejects.toMatchObject({ message: 'APPROVAL_FORBIDDEN' });
    const cancelled = await approvals.cancel(COMPANY, created.id, ACTOR, false, ctx, 'منصرف شدم');
    expect(cancelled.status).toBe('CANCELLED');
    expect(await prisma.approvalEvent.count({ where: { requestId: created.id, kind: 'CANCELLED' } })).toBe(1);
    // decided/cancelled rows are not cancellable
    await expect(
      approvals.cancel(COMPANY, created.id, ACTOR, false, ctx),
    ).rejects.toMatchObject({ message: 'APPROVAL_NOT_CANCELLABLE' });
  });

  itif('a-04 OWN-scope list/detail: requester sees own rows only; scopeAll holder sees everything', async () => {
    const loadingA = await makeLoading();
    const loadingB = await makeLoading();
    const own = await approvals.create(
      COMPANY, { entityType: 'loading', entityId: loadingA, approvalType: 'RELEASE_DRIVER_INFO' }, ACTOR, ctx,
    );
    const other = await approvals.create(
      COMPANY, { entityType: 'loading', entityId: loadingB, approvalType: 'RELEASE_DRIVER_INFO' }, DECIDER, ctx,
    );
    // OWN viewer
    const ownList = await approvals.list(COMPANY, { page: 1, pageSize: 50 } as never, {
      userId: ACTOR.id, scopeAll: false,
    });
    const ownIds = ownList.items.map((i) => i.id);
    expect(ownIds).toContain(own.id);
    expect(ownIds).not.toContain(other.id);
    await expect(
      approvals.getById(COMPANY, other.id, { userId: ACTOR.id, scopeAll: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // scopeAll viewer sees both
    const allList = await approvals.list(COMPANY, { page: 1, pageSize: 50 } as never, {
      userId: DECIDER.id, scopeAll: true,
    });
    const allIds = allList.items.map((i) => i.id);
    expect(allIds).toContain(own.id);
    expect(allIds).toContain(other.id);
  });

  itif('a-05 concurrent decide reconciles: exactly one winner, one APPROVAL_ALREADY_DECIDED; history REQUESTED→DECIDED', async () => {
    const loadingId = await makeLoading();
    const created = await approvals.create(
      COMPANY, { entityType: 'loading', entityId: loadingId, approvalType: 'RELEASE_DRIVER_INFO' }, ACTOR, ctx,
    );
    const results = await Promise.allSettled([
      approvals.decide(COMPANY, created.id, { decision: 'APPROVED', note: 'ok' }, DECIDER, ctx),
      approvals.decide(COMPANY, created.id, { decision: 'REJECTED', note: 'no' }, DECIDER, ctx),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ message: 'APPROVAL_ALREADY_DECIDED' });
    const final = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: created.id } });
    expect(['APPROVED', 'REJECTED']).toContain(final.status);
    expect(final.decidedBy).toBe(DECIDER.id);
    const events = await prisma.approvalEvent.findMany({ where: { requestId: created.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['REQUESTED', 'DECIDED']);
  });

  itif('a-06 regression: APPROVED RELEASE_DRIVER_INFO still releases the restricted driver info (Phase 6 effect intact)', async () => {
    const loadingId = await makeLoading();
    const created = await approvals.create(
      COMPANY, { entityType: 'loading', entityId: loadingId, approvalType: 'RELEASE_DRIVER_INFO' }, ACTOR, ctx,
    );
    await approvals.decide(COMPANY, created.id, { decision: 'APPROVED', note: 'تایید مدیر' }, DECIDER, ctx);
    const loading = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(loading.driverInfoRestricted).toBe(false);
  });
});
