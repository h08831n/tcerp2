import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
  TimerStatus,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowState,
  WorkflowTimer,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { QueueHandler } from '../queue/queue.handlers';
import { NotificationService } from '../notifications/notifications.service';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

export interface ScheduleTimerInput {
  workflowInstanceId: string;
  stateId: string;
  timerType: string; // ESCALATION | REMINDER | TIMEOUT
  dueAt: Date;
  actionConfig: Record<string, unknown>;
}

/**
 * Minimal action registry executed when a timer fires. First action:
 * `escalate` — creates a notification for the configured role(s).
 */
export class WorkflowActionRegistry {
  private readonly actions = new Map<string, (config: Record<string, unknown>, ctx: ActionContext) => Promise<void>>();

  constructor() {
    this.register('escalate', async (config, ctx) => {
      const roles = Array.isArray(config.roles) ? (config.roles as string[]) : [];
      const value = typeof config.role === 'string' ? [config.role] : roles;
      const recipients = value.map((role) => ({ type: 'ROLE' as const, value: role }));
      if (recipients.length === 0) return;
      await ctx.notifications.createNotifications(
        await ctx.notifications.resolveRecipients(ctx.companyId, recipients, config),
        {
          companyId: ctx.companyId,
          title: typeof config.title === 'string' ? config.title : 'ارسال به مدیر',
          body: typeof config.body === 'string' ? config.body : undefined,
          relatedEntityType: ctx.entityType,
          relatedEntityId: ctx.entityId,
          priority: 'HIGH',
        },
      );
    });
  }

  register(
    type: string,
    run: (config: Record<string, unknown>, ctx: ActionContext) => Promise<void>,
  ): void {
    this.actions.set(type, run);
  }

  async run(type: string, config: Record<string, unknown>, ctx: ActionContext): Promise<void> {
    const action = this.actions.get(type);
    if (!action) throw new ValidationError(`Unknown workflow timer action "${type}"`, { type });
    await action(config, ctx);
  }
}

export interface ActionContext {
  companyId: string;
  entityType: string;
  entityId: string;
  notifications: NotificationService;
}

@Injectable()
export class WorkflowTimerService {
  private readonly logger = new Logger('WorkflowTimer');

  readonly actions = new WorkflowActionRegistry();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly notifications: NotificationService,
  ) {}

  // ── Minimal definition/state/instance helpers (used by the engine & tests) ──

  async createDefinition(
    companyId: string,
    data: { code: string; name: string; entityType: string },
  ): Promise<WorkflowDefinition> {
    return this.prisma.workflowDefinition.upsert({
      where: { companyId_code: { companyId, code: data.code } },
      create: { companyId, ...data },
      update: { name: data.name, entityType: data.entityType },
    });
  }

  async createState(definitionId: string, code: string, name: string): Promise<WorkflowState> {
    return this.prisma.workflowState.upsert({
      where: { definitionId_code: { definitionId, code } },
      create: { definitionId, code, name },
      update: { name },
    });
  }

  async createInstance(
    definitionId: string,
    entityType: string,
    entityId: string,
    currentStateId?: string,
  ): Promise<WorkflowInstance> {
    return this.prisma.workflowInstance.upsert({
      where: { definitionId_entityType_entityId: { definitionId, entityType, entityId } },
      create: { definitionId, entityType, entityId, currentStateId },
      update: { currentStateId },
    });
  }

  // ── Timers ──

  /**
   * Schedule a timer: durable row (SCHEDULED) + delayed queue job
   * (`workflow.timer`, jobId = timer id) so both the BullMQ and DB-polling
   * drivers execute it when due.
   */
  async schedule(companyId: string, input: ScheduleTimerInput): Promise<WorkflowTimer> {
    const instance = await this.prisma.workflowInstance.findUnique({
      where: { id: input.workflowInstanceId },
      include: { definition: true },
    });
    if (!instance || instance.definition.companyId !== companyId) {
      throw new NotFoundError('Workflow instance not found', { workflowInstanceId: input.workflowInstanceId });
    }
    const state = await this.prisma.workflowState.findUnique({ where: { id: input.stateId } });
    if (!state || state.definitionId !== instance.definitionId) {
      throw new ValidationError('Timer state does not belong to the instance definition');
    }
    if (!(input.dueAt.getTime() > Date.now())) {
      throw new ValidationError('Timer dueAt must be in the future');
    }

    const timer = await this.prisma.workflowTimer.create({
      data: {
        workflowInstanceId: input.workflowInstanceId,
        stateId: input.stateId,
        timerType: input.timerType,
        dueAt: input.dueAt,
        status: 'SCHEDULED',
        actionConfig: input.actionConfig as Prisma.InputJsonValue,
      },
    });

    await this.queueService.enqueue({
      jobType: 'workflow.timer',
      companyId,
      payload: { timerId: timer.id },
      // Durable one-shot: idempotent per timer, delay = time until due.
      idempotencyKey: `workflow-timer:${timer.id}`,
      delayMs: input.dueAt.getTime() - Date.now(),
      maxAttempts: 3,
    });
    return timer;
  }

  async cancel(companyId: string, id: string): Promise<WorkflowTimer> {
    const timer = await this.getById(companyId, id);
    if (timer.status !== 'SCHEDULED') {
      throw new ValidationError('Only SCHEDULED timers can be cancelled', { status: timer.status });
    }
    const cancelled = await this.prisma.workflowTimer.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });
    // BullMQ removal is best-effort — the handler no-ops on CANCELLED anyway.
    try {
      // Mini-Gate: the unique is (companyId, idempotencyKey) — findFirst with
      // the timer's company (the enqueue above used the same scope).
      const job = await this.prisma.queueJob.findFirst({
        where: { companyId, idempotencyKey: `workflow-timer:${id}` },
        select: { id: true },
      });
      if (job) await this.queueService.cancel(job.id);
    } catch {
      this.logger.debug(`Queue job for timer ${id} already gone`);
    }
    return cancelled;
  }

  /**
   * Process a due timer (the `workflow.timer` queue handler path). A
   * CANCELLED timer is a no-op; an executed action sets EXECUTED + executedAt.
   */
  async processDue(timerId: string): Promise<WorkflowTimer | null> {
    const timer = await this.prisma.workflowTimer.findUnique({
      where: { id: timerId },
      include: { instance: true },
    });
    if (!timer) return null;
    if (timer.status !== 'SCHEDULED') return null; // cancelled/executed → no-op
    if (timer.dueAt.getTime() > Date.now()) return timer; // not due yet

    const instance = timer.instance;
    const definition = await this.prisma.workflowDefinition.findUnique({
      where: { id: instance.definitionId },
    });
    const config = (timer.actionConfig ?? {}) as Record<string, unknown>;
    const actionType = typeof config.action === 'string' ? config.action : timer.timerType.toLowerCase();
    await this.actions.run(actionType, config, {
      companyId: definition?.companyId ?? '',
      entityType: instance.entityType,
      entityId: instance.entityId,
      notifications: this.notifications,
    });

    return this.prisma.workflowTimer.update({
      where: { id: timer.id },
      data: { status: 'EXECUTED' as TimerStatus, executedAt: new Date() },
    });
  }

  async getById(companyId: string, id: string): Promise<WorkflowTimer> {
    const timer = await this.prisma.workflowTimer.findUnique({
      where: { id },
      include: { instance: { include: { definition: true } } },
    });
    if (!timer || timer.instance.definition.companyId !== companyId) {
      throw new NotFoundError('Workflow timer not found', { id });
    }
    return timer;
  }

  async list(companyId: string, status?: TimerStatus): Promise<WorkflowTimer[]> {
    return this.prisma.workflowTimer.findMany({
      where: { status, instance: { definition: { companyId } } },
      orderBy: { dueAt: 'asc' },
    });
  }
}

/** Queue handler `workflow.timer` — executes due timers. */
@Injectable()
export class WorkflowTimerHandler implements QueueHandler {
  readonly type = 'workflow.timer';

  constructor(private readonly timers: WorkflowTimerService) {}

  async handle(payload: unknown): Promise<void> {
    const { timerId } = (payload ?? {}) as { timerId?: string };
    if (typeof timerId !== 'string') return;
    await this.timers.processDue(timerId);
  }
}
