import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, automationService, makeQueueService, createVariantInCompany } from '../testing/p5-fixtures';
import { PublishingService } from '../publishing/publishing.service';
import { NotificationService } from '../notifications/notifications.service';
import { ActivityService } from '../activities/activity.service';
import { TimelineService } from '../parties/timeline.service';
import { AuditService } from '../audit/audit.service';
import { PrismaClient, Prisma } from '@prisma/client';
import type { AutomationService } from './automation.service';
import { QueueService } from '../queue/queue.service';

/**
 * p9c — Phase 9C automation hardening:
 *   c-01 bounded DURABLE retry: a failing action retries the SAME run row
 *        (attempts counter) until the budget caps at terminal FAILED;
 *   c-02 execution delay: a matched event creates a PENDING run + a delayed
 *        queue job instead of executing inline;
 *   c-03 dry-run is strictly read-only (no run rows / jobs / notifications);
 *   c-04 CREATE_ACTIVITY creates a REAL activity via the Phase 9A engine,
 *        idempotent per run.
 */
describeIntegration('p9c automation retry/delay/dry-run/activity', () => {
  const prisma = integrationPrisma();
  const marker = `p9c-${Date.now()}`;
  let actorId = '';
  let audit: AuditService;
  let base: AutomationService;
  const ruleIds: string[] = [];
  const queue: QueueService = makeQueueService(prisma);

  const cleanup = async () => {
    const runs = await prisma.automationRun.findMany({
      where: { rule: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9C-' } } },
      select: { id: true },
    });
    await prisma.activity.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: 'activity:p9c-' } },
    }).catch(() => undefined);
    await prisma.automationRun.deleteMany({
      where: { rule: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9C-' } } },
    });
    await prisma.automationRule.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9C-' } },
    });
    await prisma.queueJob.deleteMany({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        OR: [
          { idempotencyKey: { startsWith: 'automation-retry:' } },
          { idempotencyKey: { startsWith: 'auto-run:p9c-' } },
          { jobType: 'automation.run', idempotencyKey: { startsWith: 'p9c-' } },
        ],
      },
    }).catch(() => undefined);
    await prisma.notification.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, relatedEntityType: 'automation_activity' },
    });
    await prisma.timelineEvent.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, type: 'ACTIVITY_CREATED' },
    }).catch(() => undefined);
  };

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    audit = new AuditService(prisma as never);
    base = automationService(
      prisma as never,
      { createAutoBatch: async () => { throw new Error('not used'); } } as never,
      queue,
    );
  });

  afterAll(async () => {
    await cleanup();
    await disconnectIntegrationPrisma();
  });

  const actor = () => ({ id: actorId, username: 'admin' });

  async function makeRule(input: {
    code: string;
    triggerType: 'CUSTOMER_INACTIVE_DAYS' | 'MANUAL' | 'PRICE_UPDATED';
    actionType: 'CREATE_ACTIVITY' | 'CREATE_NOTIFICATION' | 'PUBLISH_PRICE';
    triggerConfig?: Record<string, unknown>;
    actionConfig?: Record<string, unknown>;
  }) {
    const rule = await prisma.automationRule.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P9C-${input.code}-${Date.now()}`,
        nameFa: `قاعده ${input.code}`,
        triggerType: input.triggerType,
        triggerConfig: (input.triggerConfig ?? {}) as Prisma.InputJsonValue,
        actionType: input.actionType,
        actionConfig: (input.actionConfig ?? {}) as Prisma.InputJsonValue,
        enabled: true,
      },
    });
    ruleIds.push(rule.id);
    return rule;
  }

  /** Service clone whose publishing dependency always fails (retry driver). */
  function failingPublishService(): AutomationService {
    const publishing = {
      createAutoBatch: async () => {
        throw new Error('INJECTED: publish down');
      },
    } as never;
    return automationService(prisma as never, publishing, queue);
  }

  it('c-01 failing action retries the SAME run row until the budget caps at FAILED', async () => {
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, `${marker}-retry`);
    const rule = await makeRule({
      code: 'RETRY',
      triggerType: 'PRICE_UPDATED',
      actionType: 'PUBLISH_PRICE',
      actionConfig: { channels: ['WEBSITE'], retry: { maxAttempts: 2, delayMinutes: 1 } },
    });
    const broken = failingPublishService();
    // PRICE_UPDATED manual run: builds the real variant event and enqueues;
    // the run stays PENDING until a handler/executeRun processes it.
    const manual = await broken.manualRun(INTEGRATION_COMPANY_ID, rule.id, { entityId: fixture.variantId });
    expect(manual.runs).toHaveLength(1);
    const runId = manual.runs[0].id;
    // attempt 1: the injected publish failure triggers the bounded retry —
    // the run resets to PENDING + schedules a retry job (attempts persisted).
    const first = await broken.executeRun(runId);
    expect(first?.attempts).toBe(1);
    const afterFirst = await prisma.automationRun.findUniqueOrThrow({ where: { id: runId } });
    expect(afterFirst.status).toBe('PENDING');
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.error).toContain('INJECTED');
    const retryJob = await prisma.queueJob.findFirst({
      where: { idempotencyKey: `automation-retry:${runId}:1` },
    });
    expect(retryJob).not.toBeNull();
    // attempt 2 — budget (maxAttempts=2) exhausted → terminal FAILED, no further job
    const second = await broken.executeRun(runId);
    expect(second?.status).toBe('FAILED');
    expect(second?.attempts).toBe(2);
    const retryJob2 = await prisma.queueJob.findFirst({
      where: { idempotencyKey: `automation-retry:${runId}:2` },
    });
    expect(retryJob2).toBeNull();
  });

  it('c-01b successful retry recovers the run to SUCCESS on the same row', async () => {
    const rule = await makeRule({
      code: 'RETRY-OK',
      triggerType: 'MANUAL',
      actionType: 'CREATE_NOTIFICATION',
      actionConfig: { title: 'سلام {partyName}', retry: { maxAttempts: 3, delayMinutes: 1 } },
    });
    const run = await prisma.automationRun.create({
      data: {
        ruleId: rule.id,
        ruleVersion: rule.version,
        triggerPayload: { partyName: 'مشتری', recordOwnerId: actorId } as Prisma.InputJsonValue,
        status: 'PENDING',
        attempts: 1,
        error: 'INJECTED: previous failure',
        idempotencyKey: `p9c-manual-recover-${rule.id}`,
      },
    });
    const recovered = await base.executeRun(run.id);
    expect(recovered?.status).toBe('SUCCESS');
    expect(recovered?.attempts).toBe(2);
    expect(recovered?.finishedAt).not.toBeNull();
  });

  it('c-02 delayMinutes parks the run PENDING with a delayed queue job (no inline execution)', async () => {
    const rule = await makeRule({
      code: 'DELAYED',
      triggerType: 'MANUAL',
      actionType: 'CREATE_NOTIFICATION',
      triggerConfig: { delayMinutes: 45 },
      actionConfig: { title: 'یادآوری معلق' },
    });
    const manual = await base.manualRun(INTEGRATION_COMPANY_ID, rule.id, { entityId: null, date: undefined } as never);
    const run = manual.runs[0];
    expect(run.status).toBe('PENDING');
    const job = await prisma.queueJob.findFirst({
      where: { idempotencyKey: `auto-run:${run.id}` },
    });
    expect(job).not.toBeNull();
    expect(job?.status).toBe('SCHEDULED');
    expect((job?.payload as { runId?: string }).runId).toBe(run.id);
    // delayed: at least 40 minutes out (45 minus scheduling drift)
    expect(job?.scheduledAt.getTime()).toBeGreaterThan(Date.now() + 40 * 60 * 1000);
    // the action has NOT run yet
    expect(await prisma.notification.count({ where: { relatedEntityId: run.id } })).toBe(0);
  });

  it('c-03 dry-run is strictly read-only and reports what the action would do', async () => {
    const before = {
      runs: await prisma.automationRun.count({ where: { rule: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9C-' } } } }),
      jobs: await prisma.queueJob.count({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: 'auto-run:' } } }),
      notifications: await prisma.notification.count({ where: { companyId: INTEGRATION_COMPANY_ID } }),
    };
    // matched rule
    const rule = await makeRule({
      code: 'DRY-OK',
      triggerType: 'CUSTOMER_INACTIVE_DAYS',
      actionType: 'CREATE_NOTIFICATION',
      triggerConfig: { days: 30, delayMinutes: 10 },
      actionConfig: { title: 'پیگیری {partyName}' },
    });
    const dry = await base.dryRun(INTEGRATION_COMPANY_ID, rule.id, { entityId: undefined });
    expect(dry.matched).toBe(true);
    expect(dry.policy.delayMinutes).toBe(10);
    expect((dry.wouldDo as { action: string }).action).toBe('CREATE_NOTIFICATION');
    // condition NOT matched → skipped preview
    const rule2 = await makeRule({
      code: 'DRY-NO',
      triggerType: 'CUSTOMER_INACTIVE_DAYS',
      actionType: 'CREATE_NOTIFICATION',
      triggerConfig: { days: 30 },
      actionConfig: { title: 'هرگز' },
    });
    await prisma.automationRule.update({
      where: { id: rule2.id },
      data: { conditionConfig: { all: [{ field: 'impossibleField', equals: 'x' }] } as Prisma.InputJsonValue },
    });
    const dryNo = await base.dryRun(INTEGRATION_COMPANY_ID, rule2.id, {});
    expect(dryNo.matched).toBe(false);
    expect((dryNo.wouldDo as { skipped?: string }).skipped).toBe('CONDITION_NOT_MATCHED');
    // nothing was created
    const after = {
      runs: await prisma.automationRun.count({ where: { rule: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9C-' } } } }),
      jobs: await prisma.queueJob.count({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: 'auto-run:' } } }),
      notifications: await prisma.notification.count({ where: { companyId: INTEGRATION_COMPANY_ID } }),
    };
    expect(after).toEqual(before);
  });

  it('c-04 CREATE_ACTIVITY creates a REAL activity (9A engine), idempotent per run', async () => {
    const rule = await makeRule({
      code: 'ACT',
      triggerType: 'CUSTOMER_INACTIVE_DAYS',
      actionType: 'CREATE_ACTIVITY',
      triggerConfig: { days: 30 },
      actionConfig: { title: 'پیگیری مشتری {partyName}', typeCode: 'FOLLOW_UP', days: 3 },
    });
    // direct PENDING run row against a real party (scan semantics)
    const party = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        type: 'COMPANY',
        nameFa: `p9c مشتری ${Date.now()}`,
        ownerUserId: actorId,
      },
    });
    const run = await prisma.automationRun.create({
      data: {
        ruleId: rule.id,
        ruleVersion: rule.version,
        triggerPayload: {
          partyId: party.id,
          partyName: party.nameFa,
          inactive: true,
          recordOwnerId: actorId,
        } as Prisma.InputJsonValue,
        status: 'PENDING',
        idempotencyKey: `p9c-activity-${rule.id}`,
      },
    });
    const done = await base.executeRun(run.id);
    expect(done?.status).toBe('SUCCESS');
    const result = done?.conditionsResult as { result?: { activityId?: string; created?: boolean } };
    expect(result.result?.created).toBe(true);
    const activity = await prisma.activity.findUnique({
      where: {
        companyId_idempotencyKey: {
          companyId: INTEGRATION_COMPANY_ID,
          idempotencyKey: `activity:p9c-activity-${rule.id}`,
        },
      },
    });
    expect(activity).not.toBeNull();
    expect(activity?.createdByType).toBe('SYSTEM');
    expect(activity?.relatedEntityType).toBe('party');
    // re-execution is a no-op (executeRun idempotency) and the activity survives
    const again = await base.executeRun(run.id);
    expect(again?.status).toBe('SUCCESS');
    const activities = await prisma.activity.count({
      where: { companyId: INTEGRATION_COMPANY_ID, relatedEntityId: party.id },
    });
    expect(activities).toBe(1);
    await prisma.party.delete({ where: { id: party.id } }).catch(() => undefined);
  });

  it('c-05 PRICE_UPDATED without delay keeps the immediate path (regression)', async () => {
    const rule = await makeRule({
      code: 'IMMEDIATE',
      triggerType: 'MANUAL',
      actionType: 'CREATE_NOTIFICATION',
      actionConfig: { title: 'فوری' },
    });
    const manual = await base.manualRun(INTEGRATION_COMPANY_ID, rule.id, {} as never);
    expect(manual.runs[0].status).toBe('SUCCESS');
    const delayedJob = await prisma.queueJob.findFirst({
      where: { idempotencyKey: `auto-run:${manual.runs[0].id}` },
    });
    expect(delayedJob).toBeNull();
  });
});
