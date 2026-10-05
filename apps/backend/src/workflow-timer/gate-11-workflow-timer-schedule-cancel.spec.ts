import { WorkflowTimerService } from './workflow-timer.service';
import {
  describeIntegration,
  disconnectIntegrationPrisma,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  testUuid,
  TEST_INTEGRATION,
} from '../testing/integration';

/**
 * GATE TEST 11 — workflow timers: schedule → SCHEDULED (+ queued delayed);
 * cancel → CANCELLED; processing a due timer sets EXECUTED (+ executes the
 * action); processing a cancelled timer is a no-op.
 */
describe('11 workflow-timer-schedule-cancel', () => {
  function makeMocks(timerRow?: Record<string, unknown>) {
    const timers: Record<string, unknown>[] = [];
    const timerUpdates: Record<string, unknown>[] = [];
    const enqueued: Record<string, unknown>[] = [];
    const notificationsCreated: unknown[] = [];
    const prisma = {
      workflowInstance: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'wf-1',
          entityType: 'SALES_DOCUMENT',
          entityId: 'doc-1',
          definitionId: 'wfd-1',
          definition: { id: 'wfd-1', companyId: 'company-1' },
        }),
      },
      workflowState: {
        findUnique: jest.fn().mockResolvedValue({ id: 'state-1', definitionId: 'wfd-1' }),
      },
      workflowDefinition: {
        findUnique: jest.fn().mockResolvedValue({ id: 'wfd-1', companyId: 'company-1' }),
      },
      workflowTimer: {
        create: jest.fn(async (args: Record<string, unknown>) => {
          const row = { id: 'timer-1', status: 'SCHEDULED', ...(args.data as object) };
          timers.push(row);
          return row;
        }),
        findUnique: jest.fn(async (args: Record<string, unknown>) =>
          timerRow
            ? {
                ...timerRow,
                instance: {
                  entityType: 'SALES_DOCUMENT',
                  entityId: 'doc-1',
                  definitionId: 'wfd-1',
                  definition: { companyId: 'company-1' },
                },
              }
            : null,
        ),
        update: jest.fn(async (args: { where: { id: string }; data: object }) => {
          timerUpdates.push(args as unknown as Record<string, unknown>);
          return { id: args.where.id, ...args.data };
        }),
      },
      queueJob: { findUnique: jest.fn().mockResolvedValue({ id: 'q-1' }) },
    };
    const queueService = {
      enqueue: jest.fn(async (input: Record<string, unknown>) => {
        enqueued.push(input);
        return { id: 'q-1' };
      }),
      cancel: jest.fn(async () => ({ id: 'q-1' })),
    };
    const notifications = {
      resolveRecipients: jest.fn().mockResolvedValue(['user-1']),
      createNotifications: jest.fn(async (_users: string[], base: unknown) => {
        notificationsCreated.push(base);
        return [{}];
      }),
    };
    const service = new WorkflowTimerService(
      prisma as never,
      queueService as never,
      notifications as never,
    );
    return { service, timers, timerUpdates, enqueued, notificationsCreated, prisma, queueService };
  }

  it('schedule → SCHEDULED row + delayed workflow.timer queue job', async () => {
    const { service, enqueued } = makeMocks();
    const dueAt = new Date(Date.now() + 60_000);

    const timer = await service.schedule('company-1', {
      workflowInstanceId: 'wf-1',
      stateId: 'state-1',
      timerType: 'ESCALATION',
      dueAt,
      actionConfig: { action: 'escalate', role: 'sales_manager' },
    });

    expect(timer.status).toBe('SCHEDULED');
    expect(enqueued[0]).toEqual(
      expect.objectContaining({
        jobType: 'workflow.timer',
        payload: { timerId: 'timer-1' },
        idempotencyKey: 'workflow-timer:timer-1',
        maxAttempts: 3,
      }),
    );
    expect(enqueued[0].delayMs as number).toBeGreaterThan(50_000);
  });

  it('cancel → CANCELLED (and queue job removed best-effort)', async () => {
    const { service, queueService, prisma } = makeMocks({
      id: 'timer-1',
      status: 'SCHEDULED',
      timerType: 'ESCALATION',
      dueAt: new Date(Date.now() + 60_000),
      actionConfig: { action: 'escalate', role: 'sales_manager' },
    });
    const cancelled = await service.cancel('company-1', 'timer-1');
    expect(cancelled.status).toBe('CANCELLED');
    expect(prisma.queueJob.findUnique).toHaveBeenCalledWith({
      where: { idempotencyKey: 'workflow-timer:timer-1' },
      select: { id: true },
    });
    expect(queueService.cancel).toHaveBeenCalledWith('q-1');
  });

  it('processing a due timer sets EXECUTED and runs the action', async () => {
    const { service, timerUpdates, notificationsCreated } = makeMocks({
      id: 'timer-1',
      status: 'SCHEDULED',
      timerType: 'ESCALATION',
      dueAt: new Date(Date.now() - 1000), // due
      actionConfig: { action: 'escalate', role: 'sales_manager', title: 'پیگیری شود' },
    });

    const processed = await service.processDue('timer-1');

    expect(processed?.status).toBe('EXECUTED');
    expect(timerUpdates[0]).toEqual(
      expect.objectContaining({
        where: { id: 'timer-1' },
        data: expect.objectContaining({ status: 'EXECUTED' }),
      }),
    );
    expect(notificationsCreated[0]).toEqual(
      expect.objectContaining({ title: 'پیگیری شود', relatedEntityType: 'SALES_DOCUMENT' }),
    );
  });

  it('processing a cancelled timer is a no-op', async () => {
    const { service, timerUpdates, notificationsCreated } = makeMocks({
      id: 'timer-1',
      status: 'CANCELLED',
      timerType: 'ESCALATION',
      dueAt: new Date(Date.now() - 1000),
      actionConfig: { action: 'escalate', role: 'sales_manager' },
    });

    const result = await service.processDue('timer-1');

    expect(result).toBeNull();
    expect(timerUpdates).toHaveLength(0);
    expect(notificationsCreated).toHaveLength(0);
  });

  it('processing a not-yet-due timer leaves it SCHEDULED', async () => {
    const { service, timerUpdates } = makeMocks({
      id: 'timer-1',
      status: 'SCHEDULED',
      timerType: 'ESCALATION',
      dueAt: new Date(Date.now() + 60_000),
      actionConfig: { action: 'escalate' },
    });
    const result = await service.processDue('timer-1');
    expect(result?.status).toBe('SCHEDULED');
    expect(timerUpdates).toHaveLength(0);
  });

  describeIntegration('integration (definition/state/instance helpers on live DB)', () => {
    const prisma = integrationPrisma();
    let service: WorkflowTimerService;
    const entityIds: string[] = [];

    afterAll(async () => {
      if (!TEST_INTEGRATION) return;
      for (const entityId of entityIds) {
        await prisma.workflowInstance.deleteMany({
          where: { entityId, definition: { companyId: INTEGRATION_COMPANY_ID } },
        });
      }
      await prisma.workflowState.deleteMany({ where: { definition: { companyId: INTEGRATION_COMPANY_ID, code: 'gate-11' } } });
      await prisma.workflowDefinition.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: 'gate-11' } });
      await disconnectIntegrationPrisma();
    });

    it('createDefinition / createState / createInstance persist', async () => {
      if (!TEST_INTEGRATION) return;
      service = new WorkflowTimerService(
        prisma as unknown as import('../prisma/prisma.service').PrismaService,
        {} as never,
        {} as never,
      );
      const definition = await service.createDefinition(INTEGRATION_COMPANY_ID, {
        code: 'gate-11',
        name: 'Gate 11 workflow',
        entityType: 'TEST',
      });
      const state = await service.createState(definition.id, 'NEW', 'جدید');
      const entityId = testUuid();
      entityIds.push(entityId);
      const instance = await service.createInstance(definition.id, 'TEST', entityId, state.id);
      expect(instance.currentStateId).toBe(state.id);
      expect(state.definitionId).toBe(definition.id);
    });
  });
});
