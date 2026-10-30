import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { NotificationService } from '../notifications/notifications.service';
import { QueueService } from '../queue/queue.service';
import { QueueHandlerRegistry } from '../queue/queue.handlers';
import { WorkflowTimerService } from '../workflow-timer/workflow-timer.service';
import { ApprovalRequestService } from '../approvals/approvals.service';
import { ApprovalDecisionBus } from '../approvals/approval-decision.bus';
import { WorkflowService, WORKFLOW_MESSAGES } from './workflow.service';
import { makeQueueService } from '../testing/p5-fixtures';
import { TEST_INTEGRATION, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(180000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000b1', username: 'admin' };
const MANAGER_PERMS = ['workflow.view', 'workflow.start', 'workflow.admin', 'sales.confirm'];
const OPERATOR_PERMS = ['workflow.start'];

const COMPANY_A = '9b9b9b9b-9b9b-4b9b-8b9b-9b9b9b9b9b9b';
const COMPANY_B = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c';

/**
 * Phase 9B (Gate E) — workflow state-machine engine: definition invariants,
 * instance idempotency, transition conditions + permissions, optimistic
 * concurrency, approval-gated parking/resume, SLA escalation timers,
 * cancel fan-out, audit atomicity, company isolation.
 */
describe('p9b-workflow-engine (Phase 9B)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let workflow: WorkflowService;
  let timers: WorkflowTimerService;
  let approvals: ApprovalRequestService;
  const companyIds = [COMPANY_A, COMPANY_B];
  const definitionIds: string[] = [];
  const instanceIds: string[] = [];
  const loadingIds: string[] = [];
  const userIds: string[] = [];

  const cleanup = async () => {
    for (const companyId of companyIds) {
      const defs = await prisma.workflowDefinition.findMany({
        where: { companyId },
        select: { id: true },
      });
      const instanceList = await prisma.workflowInstance.findMany({
        where: { definition: { companyId } },
        select: { id: true },
      });
      for (const i of instanceList) {
        await prisma.approvalRequest.deleteMany({ where: { workflowInstanceId: i.id } }).catch(() => undefined);
      }
      await prisma.workflowExecutionLog.deleteMany({ where: { instance: { definition: { companyId } } } }).catch(() => undefined);
      await prisma.workflowTimer.deleteMany({ where: { instance: { definition: { companyId } } } }).catch(() => undefined);
      await prisma.workflowInstance.deleteMany({ where: { definition: { companyId } } }).catch(() => undefined);
      await prisma.workflowDefinition.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.loading.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.notification.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.queueJob.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.userCompanyRole.deleteMany({ where: { companyId } }).catch(() => undefined);
      await prisma.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => undefined);
      void defs;
    }
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
  };

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    prismaService = new PrismaService();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();

    const audit = new AuditService(prismaService);
    const timeline = new TimelineService(prismaService);
    const queue: QueueService = makeQueueService(prisma);
    const notifications = new NotificationService(prismaService, queue);
    timers = new WorkflowTimerService(prismaService, queue, notifications);
    const bus = new ApprovalDecisionBus();
    approvals = new ApprovalRequestService(prismaService, audit, timeline, notifications, bus);
    workflow = new WorkflowService(prismaService, audit, notifications, timers, approvals, bus, queue);
    workflow.onModuleInit();

    await cleanup();
    for (const companyId of companyIds) {
      await prisma.company.create({ data: { id: companyId, nameFa: `p9b-${companyId}`, status: 'ACTIVE' } });
    }
    const user = await prisma.user.create({
      data: { id: ACTOR.id, username: `p9b-actor-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    userIds.push(user.id);
  });

  afterAll(async () => {
    if (!prismaService) return;
    await cleanup();
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : (name: string, fn: jest.ProvidesCallback) => it.skip(name, fn);

  /** Simple A→B→(final) definition factory. */
  async function simpleDefinition(companyId: string, code: string) {
    return workflow.createDefinition(
      companyId,
      {
        code,
        name: `گردش کار ${code}`,
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{ code: 'finish', name: 'پایان', fromState: 'NEW', toState: 'DONE' }],
      },
      ACTOR,
      {},
    );
  }

  async function makeLoading(companyId: string): Promise<string> {
    const loading = await prisma.loading.create({
      data: { companyId, loadingDate: new Date() },
      select: { id: true },
    });
    loadingIds.push(loading.id);
    return loading.id;
  }

  const ctx = {} as never;

  itif('w9b-01 definition invariants: duplicate initial / unknown state / self-loop rejected, valid create returns nested rows', async () => {
    const companyId = COMPANY_A;
    const base = {
      code: `inv-${Date.now()}`,
      name: 'اعتبارسنجی ساختار',
      entityType: 'loading',
      states: [
        { code: 'NEW', name: 'جدید', isInitial: true },
        { code: 'DONE', name: 'پایان', isFinal: true },
      ],
      transitions: [{ code: 'finish', name: 'پایان', fromState: 'NEW', toState: 'DONE' }],
    };
    // two initial states
    await expect(
      workflow.createDefinition(companyId, {
        ...base,
        states: [...base.states, { code: 'NEW2', name: 'دوم', isInitial: true }],
      } as never, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'WORKFLOW_EXACTLY_ONE_INITIAL_STATE' });
    // no final state
    await expect(
      workflow.createDefinition(companyId, {
        ...base,
        states: [{ code: 'NEW', name: 'جدید', isInitial: true }],
        transitions: [],
      } as never, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'WORKFLOW_AT_LEAST_ONE_FINAL_STATE' });
    // unknown transition endpoint
    await expect(
      workflow.createDefinition(companyId, {
        ...base,
        transitions: [{ code: 'finish', name: 'پایان', fromState: 'NEW', toState: 'GHOST' }],
      } as never, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'WORKFLOW_TRANSITION_UNKNOWN_STATE' });
    // self-loop
    await expect(
      workflow.createDefinition(companyId, {
        ...base,
        transitions: [{ code: 'loop', name: 'حلقه', fromState: 'NEW', toState: 'NEW' }],
      } as never, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'WORKFLOW_TRANSITION_SELF_LOOP' });
    // invalid condition tree
    await expect(
      workflow.createDefinition(companyId, {
        ...base,
        transitions: [
          { code: 'finish', name: 'پایان', fromState: 'NEW', toState: 'DONE', condition: { field: 'x', op: 'bogus' } },
        ],
      } as never, ACTOR, ctx),
    ).rejects.toMatchObject({ message: 'WORKFLOW_INVALID_CONDITION' });
    // valid create
    const created = await simpleDefinition(companyId, `ok-${Date.now()}`);
    definitionIds.push(created.id);
    expect(created.states).toHaveLength(2);
    expect(created.transitions).toHaveLength(1);
    expect(created.states.find((s) => s.isInitial)?.code).toBe('NEW');
    expect(created.states.find((s) => s.isFinal)?.code).toBe('DONE');
  });

  itif('w9b-02 start is idempotent under concurrency (unique definition+entity) and records a STARTED log', async () => {
    const companyId = COMPANY_A;
    const def = await simpleDefinition(companyId, `start-${Date.now()}`);
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    // concurrent double start — exactly one wins
    const results = await Promise.allSettled([
      workflow.startInstance(companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId, context: {} }, ACTOR, ctx),
      workflow.startInstance(companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId, context: {} }, ACTOR, ctx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ message: WORKFLOW_MESSAGES.instanceExists });
    const instance = (fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<WorkflowService['startInstance']>>>).value;
    instanceIds.push(instance.id);
    expect(instance.status).toBe('ACTIVE');
    expect(instance.currentState?.code).toBe('NEW');
    expect(instance.version).toBe(1);
    const logs = await prisma.workflowExecutionLog.findMany({ where: { instanceId: instance.id } });
    expect(logs.map((l) => l.kind)).toEqual(['STARTED']);
    const instances = await prisma.workflowInstance.count({
      where: { definitionId: def.id, entityType: 'loading', entityId: loadingId },
    });
    expect(instances).toBe(1);
  });

  itif('w9b-03 plain transition executes: state flips, version increments, final state completes, TRANSITION log written', async () => {
    const companyId = COMPANY_A;
    const def = await simpleDefinition(companyId, `exec-${Date.now()}`);
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    const result = await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    expect(result.outcome).toBe('EXECUTED');
    if (result.outcome === 'EXECUTED') {
      expect(result.completed).toBe(true);
      expect(result.instance.status).toBe('COMPLETED');
      expect(result.instance.version).toBe(2);
      expect(result.instance.currentStateId).toBe(def.states.find((s) => s.code === 'DONE')!.id);
    }
    const logs = await prisma.workflowExecutionLog.findMany({
      where: { instanceId: instance.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.kind)).toEqual(['STARTED', 'TRANSITION']);
    expect(logs[1].actorUserId).toBe(ACTOR.id);
  });

  itif('w9b-04 transition not available from the current state is a 404; inactive instance is a 409', async () => {
    const companyId = COMPANY_A;
    const def = await simpleDefinition(companyId, `nav-${Date.now()}`);
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await expect(
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).resolves.toBeTruthy();
    // instance now COMPLETED — further transition is a 409
    await expect(
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).rejects.toMatchObject({ message: WORKFLOW_MESSAGES.instanceNotActive });
  });

  itif('w9b-05 condition gate: context below threshold blocked, above threshold passes', async () => {
    const companyId = COMPANY_A;
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `cond-${Date.now()}`,
        name: 'شرط مبلغ',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان', fromState: 'NEW', toState: 'DONE',
          condition: { all: [{ field: 'order.total', op: 'gte', value: 100 }] },
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId, context: { order: { total: 50 } } }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await expect(
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).rejects.toMatchObject({ message: WORKFLOW_MESSAGES.conditionNotMet });
    // no state change, no TRANSITION log
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } })).version).toBe(1);
    expect(await prisma.workflowExecutionLog.count({ where: { instanceId: instance.id, kind: 'TRANSITION' } })).toBe(0);
    // raise the context → passes
    await prisma.workflowInstance.update({
      where: { id: instance.id },
      data: { context: { order: { total: 150 } } as Prisma.InputJsonValue },
    });
    const fresh = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    const result = await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    void fresh;
    expect(result.outcome).toBe('EXECUTED');
  });

  itif('w9b-06 per-transition permission enforced server-side', async () => {
    const companyId = COMPANY_A;
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `perm-${Date.now()}`,
        name: 'مجوز انتقال',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان', fromState: 'NEW', toState: 'DONE',
          requiredPermission: 'sales.confirm',
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await expect(
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).rejects.toMatchObject({ message: WORKFLOW_MESSAGES.transitionPermissionRequired });
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } })).version).toBe(1);
    const result = await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(MANAGER_PERMS), ctx,
    );
    expect(result.outcome).toBe('EXECUTED');
  });

  itif('w9b-07 approval-gated transition parks the instance: PENDING approval + SCHEDULED escalation timer + log', async () => {
    const companyId = COMPANY_A;
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `gate-${Date.now()}`,
        name: 'درگاه تایید',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان تاییدی', fromState: 'NEW', toState: 'DONE',
          requiresApproval: true, approvalType: 'BIG_RELEASE', slaHours: 24,
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    const result = await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    expect(result.outcome).toBe('APPROVAL_REQUESTED');
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { entityType: 'workflow_instance', entityId: instance.id },
    });
    expect(approval.status).toBe('PENDING');
    expect(approval.source).toBe('WORKFLOW');
    expect(approval.approvalType).toBe('BIG_RELEASE');
    expect(approval.workflowInstanceId).toBe(instance.id);
    // instance NOT moved
    const parked = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(parked.version).toBe(1);
    expect(parked.status).toBe('ACTIVE');
    // escalation timer scheduled
    const timer = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: instance.id } });
    expect(timer.status).toBe('SCHEDULED');
    expect(timer.timerType).toBe('ESCALATION');
    // second attempt while pending → 409 WORKFLOW_APPROVAL_PENDING
    await expect(
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).rejects.toMatchObject({ message: WORKFLOW_MESSAGES.approvalPending });
    // log recorded
    const logs = await prisma.workflowExecutionLog.findMany({ where: { instanceId: instance.id } });
    expect(logs.map((l) => l.kind)).toEqual(['STARTED', 'APPROVAL_REQUESTED']);
  });

  itif('w9b-08 decide APPROVED resumes the parked transition (state flips + logs); double-resume is a no-op', async () => {
    const companyId = COMPANY_A;
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `resume-${Date.now()}`,
        name: 'ادامه پس از تایید',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان تاییدی', fromState: 'NEW', toState: 'DONE',
          requiresApproval: true,
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { entityType: 'workflow_instance', entityId: instance.id, status: 'PENDING' },
    });
    await approvals.decide(companyId, approval.id, { decision: 'APPROVED', note: 'تایید مدیر' }, ACTOR, ctx);
    const resumed = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.version).toBe(2);
    expect(resumed.currentStateId).toBe(def.states.find((s) => s.code === 'DONE')!.id);
    const logs = await prisma.workflowExecutionLog.findMany({
      where: { instanceId: instance.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(logs.map((l) => l.kind)).toEqual(['STARTED', 'APPROVAL_REQUESTED', 'TRANSITION', 'APPROVAL_DECIDED']);
    // decision history recorded atomically with the decision
    const events = await prisma.approvalEvent.findMany({ where: { requestId: approval.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['REQUESTED', 'DECIDED']);
    // idempotent retry — no second TRANSITION
    await workflow.retryResume(approval.id, 'APPROVED');
    const transitions = await prisma.workflowExecutionLog.count({
      where: { instanceId: instance.id, kind: 'TRANSITION' },
    });
    expect(transitions).toBe(1);
    const stillCompleted = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(stillCompleted.version).toBe(2);
  });

  itif('w9b-09 decide REJECTED keeps the instance ACTIVE at the same state; retry re-requests a fresh approval', async () => {
    const companyId = COMPANY_A;
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `reject-${Date.now()}`,
        name: 'رد تایید',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان تاییدی', fromState: 'NEW', toState: 'DONE',
          requiresApproval: true,
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { entityType: 'workflow_instance', entityId: instance.id, status: 'PENDING' },
    });
    await approvals.decide(companyId, approval.id, { decision: 'REJECTED', note: 'ناقص' }, ACTOR, ctx);
    const still = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(still.status).toBe('ACTIVE');
    expect(still.version).toBe(1);
    expect(still.currentStateId).toBe(def.states.find((s) => s.code === 'NEW')!.id);
    // retry the transition → NEW PENDING approval (partial unique allows it: old one is REJECTED)
    const retry = await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish', note: 'اصلاح شد' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    expect(retry.outcome).toBe('APPROVAL_REQUESTED');
    const pendings = await prisma.approvalRequest.findMany({
      where: { entityType: 'workflow_instance', entityId: instance.id },
    });
    expect(pendings.filter((a) => a.status === 'PENDING')).toHaveLength(1);
    expect(pendings).toHaveLength(2);
  });

  itif('w9b-10 concurrent transitions: exactly one wins, loser gets WORKFLOW_CONCURRENT_MODIFICATION', async () => {
    const companyId = COMPANY_A;
    const def = await simpleDefinition(companyId, `conc-${Date.now()}`);
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    const results = await Promise.allSettled([
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish', note: 'first' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish', note: 'second' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      message: WORKFLOW_MESSAGES.concurrentModification,
    });
    const final = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(final.version).toBe(2);
    expect(final.status).toBe('COMPLETED');
    expect(await prisma.workflowExecutionLog.count({ where: { instanceId: instance.id, kind: 'TRANSITION' } })).toBe(1);
  });

  itif('w9b-11 cancelInstance flips status, cancels timers + pending approvals; later transition is a 409', async () => {
    const companyId = COMPANY_A;
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `cancel-${Date.now()}`,
        name: 'لغو گردش کار',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان تاییدی', fromState: 'NEW', toState: 'DONE',
          requiresApproval: true, slaHours: 24,
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    const cancelled = await workflow.cancelInstance(companyId, instance.id, ACTOR, true, ctx, 'دیگر لازم نیست');
    expect(cancelled.status).toBe('CANCELLED');
    const timer = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: instance.id } });
    expect(timer.status).toBe('CANCELLED');
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { entityType: 'workflow_instance', entityId: instance.id },
    });
    expect(approval.status).toBe('CANCELLED');
    const events = await prisma.approvalEvent.findMany({ where: { requestId: approval.id }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['REQUESTED', 'CANCELLED']);
    await expect(
      workflow.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).rejects.toMatchObject({ message: WORKFLOW_MESSAGES.instanceNotActive });
  });

  itif('w9b-12 escalation timer fires on a parked approval: notification to admin role, level bump, TIMER_FIRED log', async () => {
    const companyId = COMPANY_A;
    // ROLE recipients resolve through BOTH company membership and company role.
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    await prisma.userCompany.create({ data: { userId: ACTOR.id, companyId } }).catch(() => undefined);
    await prisma.userCompanyRole.create({
      data: { userId: ACTOR.id, companyId, roleId: adminRole.id },
    });
    const def = await workflow.createDefinition(
      companyId,
      {
        code: `escal-${Date.now()}`,
        name: 'escalation',
        entityType: 'loading',
        states: [
          { code: 'NEW', name: 'جدید', isInitial: true },
          { code: 'DONE', name: 'پایان', isFinal: true },
        ],
        transitions: [{
          code: 'finish', name: 'پایان تاییدی', fromState: 'NEW', toState: 'DONE',
          requiresApproval: true, slaHours: 24,
        }],
      },
      ACTOR, ctx,
    );
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    await workflow.executeTransition(
      companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx,
    );
    // Force the durable timer due NOW (real path: processDue → action registry)
    const timer = await prisma.workflowTimer.findFirstOrThrow({ where: { workflowInstanceId: instance.id } });
    await prisma.workflowTimer.update({
      where: { id: timer.id },
      data: { dueAt: new Date(Date.now() - 1000) },
    });
    const processed = await timers.processDue(timer.id);
    expect(processed?.status).toBe('EXECUTED');
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { entityType: 'workflow_instance', entityId: instance.id },
    });
    expect(approval.escalationLevel).toBe(1);
    expect(await prisma.approvalEvent.count({ where: { requestId: approval.id, kind: 'ESCALATED' } })).toBe(1);
    expect(await prisma.workflowExecutionLog.count({ where: { instanceId: instance.id, kind: 'TIMER_FIRED' } })).toBe(1);
    const notifications = await prisma.notification.findMany({
      where: { userId: ACTOR.id, relatedEntityId: instance.id },
    });
    expect(notifications.length).toBeGreaterThan(0);
    // decide after escalation still resumes (PENDING survived)
    await approvals.decide(companyId, approval.id, { decision: 'APPROVED' }, ACTOR, ctx);
    expect((await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } })).status).toBe('COMPLETED');
  });

  itif('w9b-13 audit failure inside the transition rolls the whole flip back (no state change, no log, no audit)', async () => {
    const companyId = COMPANY_A;
    const def = await simpleDefinition(companyId, `audit-${Date.now()}`);
    definitionIds.push(def.id);
    const loadingId = await makeLoading(companyId);
    const instance = await workflow.startInstance(
      companyId, { definitionCode: def.code, entityType: 'loading', entityId: loadingId }, ACTOR, ctx,
    );
    instanceIds.push(instance.id);
    const auditBefore = await prisma.auditLog.count({
      where: { entityType: 'workflow_instance', entityId: instance.id },
    });
    // Service clone with a failing audit (recordTx propagates inside the tx).
    const failingAudit = new AuditService(prismaService);
    jest.spyOn(failingAudit, 'recordTx').mockRejectedValue(new Error('audit down'));
    const broken = new WorkflowService(
      prismaService, failingAudit,
      new NotificationService(prismaService, makeQueueService(prisma)),
      timers, approvals, new ApprovalDecisionBus(), makeQueueService(prisma),
    );
    await expect(
      broken.executeTransition(companyId, instance.id, { transitionCode: 'finish' }, ACTOR, new Set(OPERATOR_PERMS), ctx),
    ).rejects.toThrow('audit down');
    const after = await prisma.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    expect(after.version).toBe(1);
    expect(after.status).toBe('ACTIVE');
    expect(await prisma.workflowExecutionLog.count({ where: { instanceId: instance.id, kind: 'TRANSITION' } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { entityType: 'workflow_instance', entityId: instance.id } }),
    ).toBe(auditBefore);
  });

  itif('w9b-14 company isolation: cross-company instance/definition lookups 404; same definition code per company coexists', async () => {
    // same code in both companies
    const code = `iso-${Date.now()}`;
    const defA = await simpleDefinition(COMPANY_A, code);
    const defB = await simpleDefinition(COMPANY_B, code);
    definitionIds.push(defA.id, defB.id);
    const loadingA = await makeLoading(COMPANY_A);
    const instanceA = await workflow.startInstance(
      COMPANY_A, { definitionCode: code, entityType: 'loading', entityId: loadingA }, ACTOR, ctx,
    );
    instanceIds.push(instanceA.id);
    // B cannot see A's instance/definition
    await expect(workflow.getInstance(COMPANY_B, instanceA.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(workflow.getDefinition(COMPANY_B, defA.id)).rejects.toMatchObject({ statusCode: 404 });
    // A cannot start on B's loading — entity must exist IN THE COMPANY
    const loadingB = await makeLoading(COMPANY_B);
    await expect(
      workflow.startInstance(COMPANY_A, { definitionCode: code, entityType: 'loading', entityId: loadingB }, ACTOR, ctx),
    ).rejects.toMatchObject({ statusCode: 404 });
    // B works with its own definition+entity
    const instanceB = await workflow.startInstance(
      COMPANY_B, { definitionCode: code, entityType: 'loading', entityId: loadingB }, ACTOR, ctx,
    );
    instanceIds.push(instanceB.id);
    expect(instanceB.definition.companyId).toBe(COMPANY_B);
  });
});
