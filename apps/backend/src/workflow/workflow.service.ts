import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ApprovalRequest,
  Prisma,
  TimerStatus,
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowState,
  WorkflowTransition,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationService } from '../notifications/notifications.service';
import { WorkflowTimerService } from '../workflow-timer/workflow-timer.service';
import { ApprovalDecisionBus, ApprovalDecision } from '../approvals/approval-decision.bus';
import {
  ApprovalRequestService,
  WORKFLOW_APPROVAL_ENTITY_TYPE,
} from '../approvals/approvals.service';
import { QueueService } from '../queue/queue.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  ConditionNode,
  evaluateCondition,
  isValidConditionTree,
} from './workflow-conditions';
import { CreateWorkflowDefinitionDto, WorkflowInstanceQueryDto } from './workflow.dto';
import type { ActionContext as WorkflowTimerActionContext } from '../workflow-timer/workflow-timer.service';

export const WORKFLOW_MESSAGES = {
  definitionInactive: 'WORKFLOW_DEFINITION_INACTIVE',
  instanceExists: 'WORKFLOW_INSTANCE_EXISTS',
  instanceNotActive: 'WORKFLOW_INSTANCE_NOT_ACTIVE',
  transitionNotAvailable: 'WORKFLOW_TRANSITION_NOT_AVAILABLE',
  conditionNotMet: 'WORKFLOW_CONDITION_NOT_MET',
  transitionPermissionRequired: 'WORKFLOW_TRANSITION_PERMISSION_REQUIRED',
  concurrentModification: 'WORKFLOW_CONCURRENT_MODIFICATION',
  approvalPending: 'WORKFLOW_APPROVAL_PENDING',
  cancelForbidden: 'WORKFLOW_CANCEL_FORBIDDEN',
} as const;

/** Post-transition action configs (extensible registry: notify first). */
interface NotifyActionConfig {
  type: 'notify';
  roles?: string[];
  title?: string;
  body?: string;
}

type WorkflowActionConfig = NotifyActionConfig;

export interface WorkflowActor {
  id: string;
  username: string;
}

/** Instance-target registry: what a workflow instance may be attached to. */
const WORKFLOW_ENTITY_MODELS = {
  loading: 'loading',
  goods_receipt: 'goodsReceipt',
  sales_document: 'salesDocument',
  purchase_document: 'purchaseDocument',
} as const;

type WorkflowEntityType = keyof typeof WORKFLOW_ENTITY_MODELS;

const MAX_STATES = 64;
const MAX_TRANSITIONS = 256;

/**
 * Workflow state-machine engine (Phase 9B, Gate E — REQUIREMENTS §27):
 * company-scoped definitions (states + transitions with structured
 * conditions, per-transition permissions, approval gates, SLA timers,
 * post-transition actions), durable instances with optimistic concurrency
 * (version-guarded state flips so two simultaneous transitions can never
 * both apply), an append-only execution log, and timer-driven escalation
 * for approvals. Approval-gated transitions park the instance and resume
 * through the ApprovalDecisionBus when the decision commits.
 */
@Injectable()
export class WorkflowService implements OnModuleInit {
  private readonly logger = new Logger('WorkflowService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly timers: WorkflowTimerService,
    private readonly approvals: ApprovalRequestService,
    private readonly decisionBus: ApprovalDecisionBus,
    private readonly queue: QueueService,
  ) {}

  /** Wire the decision bridge and the timer actions this engine owns. */
  onModuleInit(): void {
    this.decisionBus.register({
      onApprovalDecided: (approval, decision) => this.resumeAfterDecision(approval, decision),
    });
    this.timers.actions.register('state_sla', (config, ctx) => this.handleStateSla(config, ctx));
    this.timers.actions.register('approval_escalate', (config, ctx) =>
      this.handleApprovalEscalation(config, ctx),
    );
  }

  /** Resolve ROLE recipients inside the company and dispatch in-app rows. */
  private async notifyRoles(
    companyId: string,
    roles: string[],
    options: {
      title: string;
      body?: string;
      relatedEntityType?: string;
      relatedEntityId?: string;
      priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';
    },
  ): Promise<void> {
    if (roles.length === 0) return;
    const userIds = await this.notifications.resolveRecipients(
      companyId,
      roles.map((role) => ({ type: 'ROLE' as const, value: role })),
      {},
    );
    if (userIds.length === 0) return;
    await this.notifications.createNotifications(userIds, options);
  }

  // ─────────────────────── Definitions (admin surface) ───────────────────────

  /**
   * Create a definition with nested states + transitions in one transaction.
   * Structural invariants: exactly one initial state, at least one final
   * state, every transition endpoint is a defined state, no self-loops,
   * valid condition trees, unique codes (DB uniques back the same rules).
   */
  async createDefinition(
    companyId: string,
    input: CreateWorkflowDefinitionDto,
    actor: WorkflowActor,
    ctx: RequestContext,
  ): Promise<WorkflowDefinition & { states: WorkflowState[]; transitions: WorkflowTransition[] }> {
    const stateCodes = new Set<string>();
    for (const state of input.states) {
      if (stateCodes.has(state.code)) {
        throw new ValidationError('WORKFLOW_DUPLICATE_STATE_CODE', { code: state.code });
      }
      stateCodes.add(state.code);
    }
    const initials = input.states.filter((s) => s.isInitial);
    if (initials.length !== 1) {
      throw new ValidationError('WORKFLOW_EXACTLY_ONE_INITIAL_STATE', { initialCount: initials.length });
    }
    if (!input.states.some((s) => s.isFinal)) {
      throw new ValidationError('WORKFLOW_AT_LEAST_ONE_FINAL_STATE');
    }
    if (input.states.length > MAX_STATES || input.transitions.length > MAX_TRANSITIONS) {
      throw new ValidationError('WORKFLOW_DEFINITION_TOO_LARGE');
    }
    const transitionCodes = new Set<string>();
    for (const transition of input.transitions) {
      if (!stateCodes.has(transition.fromState) || !stateCodes.has(transition.toState)) {
        throw new ValidationError('WORKFLOW_TRANSITION_UNKNOWN_STATE', {
          code: transition.code,
          fromState: transition.fromState,
          toState: transition.toState,
        });
      }
      if (transition.fromState === transition.toState) {
        throw new ValidationError('WORKFLOW_TRANSITION_SELF_LOOP', { code: transition.code });
      }
      if (transitionCodes.has(transition.code)) {
        throw new ValidationError('WORKFLOW_DUPLICATE_TRANSITION_CODE', { code: transition.code });
      }
      transitionCodes.add(transition.code);
      if (transition.condition && !isValidConditionTree(transition.condition)) {
        throw new ValidationError('WORKFLOW_INVALID_CONDITION', { code: transition.code });
      }
      for (const action of transition.actions ?? []) {
        if (action.type !== 'notify') {
          throw new ValidationError('WORKFLOW_UNKNOWN_ACTION_TYPE', { code: transition.code });
        }
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const definition = await tx.workflowDefinition.create({
        data: {
          companyId,
          code: input.code,
          name: input.name,
          entityType: input.entityType,
          isActive: input.isActive ?? true,
        },
      });
      const stateRows = await tx.workflowState.createManyAndReturn({
        data: input.states.map((s) => ({
          definitionId: definition.id,
          code: s.code,
          name: s.name,
          isInitial: s.isInitial ?? false,
          isFinal: s.isFinal ?? false,
          slaHours: s.slaHours,
        })),
      });
      const stateByCode = new Map(stateRows.map((s) => [s.code, s]));
      await tx.workflowTransition.createMany({
        data: input.transitions.map((t) => ({
          definitionId: definition.id,
          code: t.code,
          name: t.name,
          fromStateId: stateByCode.get(t.fromState)!.id,
          toStateId: stateByCode.get(t.toState)!.id,
          requiredPermission: t.requiredPermission,
          conditionJson: (t.condition ?? undefined) as Prisma.InputJsonValue | undefined,
          requiresApproval: t.requiresApproval ?? false,
          approvalType: t.approvalType ?? (t.requiresApproval ? t.code : undefined),
          slaHours: t.slaHours,
          actionsJson: (t.actions ?? undefined) as Prisma.InputJsonValue | undefined,
        })),
      });
      await this.audit.recordTx(tx, {
        entityType: 'workflow_definition',
        entityId: definition.id,
        action: 'WORKFLOW_DEFINITION_CREATED',
        companyId,
        actor,
        newValues: {
          code: definition.code,
          states: input.states.length,
          transitions: input.transitions.length,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return definition.id;
    }).then((definitionId) =>
      // Read the assembled definition AFTER the commit — rows created inside
      // the transaction are invisible to the service's own connection while
      // the transaction is still open.
      this.getDefinition(companyId, definitionId),
    );
  }

  /** Name / entityType / active-flag only — the structure is immutable once created. */
  async updateDefinition(
    companyId: string,
    id: string,
    input: { name?: string; entityType?: string; isActive?: boolean },
    actor: WorkflowActor,
    ctx: RequestContext,
  ): Promise<WorkflowDefinition> {
    return this.prisma.$transaction(async (tx) => {
      const definition = await tx.workflowDefinition.findFirst({
        where: { id, companyId },
        select: { id: true, name: true, isActive: true },
      });
      if (!definition) throw new NotFoundError('Workflow definition not found', { id });
      const updated = await tx.workflowDefinition.update({
        where: { id: definition.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.entityType !== undefined ? { entityType: input.entityType } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'workflow_definition',
        entityId: definition.id,
        action: 'WORKFLOW_DEFINITION_UPDATED',
        companyId,
        actor,
        oldValues: { name: definition.name, isActive: definition.isActive },
        newValues: { name: updated.name, isActive: updated.isActive },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }

  async listDefinitions(
    companyId: string,
  ): Promise<Array<WorkflowDefinition & { _count: { instances: number } }>> {
    return this.prisma.workflowDefinition.findMany({
      where: { companyId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { instances: true } } },
    });
  }

  async getDefinition(
    companyId: string,
    id: string,
  ): Promise<WorkflowDefinition & { states: WorkflowState[]; transitions: WorkflowTransition[] }> {
    const definition = await this.prisma.workflowDefinition.findFirst({
      where: { id, companyId },
      include: {
        states: { orderBy: { code: 'asc' } },
        transitions: { orderBy: { code: 'asc' } },
      },
    });
    if (!definition) throw new NotFoundError('Workflow definition not found', { id });
    return definition;
  }

  // ─────────────────────── Runtime (instances) ───────────────────────

  private async assertWorkflowEntityExists(
    companyId: string,
    entityType: string,
    entityId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const model = WORKFLOW_ENTITY_MODELS[entityType as WorkflowEntityType];
    if (!model) {
      throw new ValidationError('WORKFLOW_UNKNOWN_ENTITY_TYPE', { entityType });
    }
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const delegate = (tx as any)[model] as {
      findFirst: (args: {
        where: Record<string, unknown>;
        select: { id: true };
      }) => Promise<unknown>;
    };
    const row = await delegate.findFirst({
      where: { id: entityId, companyId },
      select: { id: true },
    });
    /* eslint-enable @typescript-eslint/no-explicit-any */
    if (!row) throw new NotFoundError('Workflow entity not found', { entityType, entityId });
  }

  /**
   * Start an instance of a definition at its initial state. Idempotency is a
   * database guarantee — the unique (definition, entityType, entityId) turns
   * a concurrent double-start into P2002 → 409 (never a second instance).
   * An initial-state slaHours schedules a durable REMINDER timer (row in the
   * same transaction, queue job after commit).
   */
  async startInstance(
    companyId: string,
    input: {
      definitionCode: string;
      entityType: string;
      entityId: string;
      context?: Record<string, unknown>;
    },
    actor: WorkflowActor,
    ctx: RequestContext,
  ): Promise<WorkflowInstance & { definition: WorkflowDefinition; currentState: WorkflowState | null }> {
    const definition = await this.prisma.workflowDefinition.findFirst({
      where: { companyId, code: input.definitionCode },
    });
    if (!definition) {
      throw new NotFoundError('Workflow definition not found', { code: input.definitionCode });
    }
    if (!definition.isActive) {
      throw new ConflictError(WORKFLOW_MESSAGES.definitionInactive, { code: definition.code });
    }
    const committed = await this.prisma.$transaction(async (tx) => {
      await this.assertWorkflowEntityExists(companyId, input.entityType, input.entityId, tx);
      const initial = await tx.workflowState.findFirst({
        where: { definitionId: definition.id, isInitial: true },
      });
      if (!initial) {
        throw new ValidationError('WORKFLOW_NO_INITIAL_STATE', { code: definition.code });
      }
      let instance: WorkflowInstance;
      try {
        instance = await tx.workflowInstance.create({
          data: {
            definitionId: definition.id,
            currentStateId: initial.id,
            entityType: input.entityType,
            entityId: input.entityId,
            status: 'ACTIVE',
            context: (input.context ?? undefined) as Prisma.InputJsonValue | undefined,
            createdBy: actor.id,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictError(WORKFLOW_MESSAGES.instanceExists, {
            definitionCode: input.definitionCode,
            entityType: input.entityType,
            entityId: input.entityId,
          });
        }
        throw error;
      }
      await tx.workflowExecutionLog.create({
        data: {
          instanceId: instance.id,
          kind: 'STARTED',
          toStateId: initial.id,
          actorUserId: actor.id,
          data: { definitionCode: definition.code } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'workflow_instance',
        entityId: instance.id,
        action: 'WORKFLOW_INSTANCE_STARTED',
        companyId,
        actor,
        newValues: {
          definitionCode: definition.code,
          entityType: input.entityType,
          entityId: input.entityId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      let slaTimerId: string | null = null;
      if (initial.slaHours && initial.slaHours > 0) {
        const dueAt = new Date(Date.now() + initial.slaHours * 3_600_000);
        const timer = await tx.workflowTimer.create({
          data: {
            workflowInstanceId: instance.id,
            stateId: initial.id,
            timerType: 'REMINDER',
            dueAt,
            status: 'SCHEDULED',
            actionConfig: {
              action: 'state_sla',
              stateCode: initial.code,
              title: `یادآوری: ${definition.name} در مرحله ${initial.name}`,
            } as Prisma.InputJsonValue,
          },
        });
        slaTimerId = timer.id;
      }
      return { instance, initial, slaTimerId };
    });

    if (committed.slaTimerId) {
      // Fire-and-forget: the durable timer row already committed; the queue
      // job only drives execution timing (the DB-polling driver would too).
      await this.queue
        .enqueue({
          jobType: 'workflow.timer',
          companyId,
          payload: { timerId: committed.slaTimerId },
          idempotencyKey: `workflow-timer:${committed.slaTimerId}`,
          delayMs: Math.max(0, (committed.initial.slaHours ?? 0) * 3_600_000),
          maxAttempts: 3,
        })
        .catch((error) =>
          this.logger.warn(`SLA reminder enqueue failed for instance ${committed.instance.id}: ${String(error)}`),
        );
    }
    return { ...committed.instance, definition, currentState: committed.initial };
  }

  async listInstances(
    companyId: string,
    query: WorkflowInstanceQueryDto,
  ): Promise<Paginated<WorkflowInstance & { definition: WorkflowDefinition; currentState: WorkflowState | null }>> {
    const where: Prisma.WorkflowInstanceWhereInput = {
      definition: { companyId },
      status: query.status,
      entityType: query.entityType,
      ...(query.definitionCode ? { definition: { is: { code: query.definitionCode } } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.workflowInstance.findMany({
        where,
        include: { definition: true, currentState: true },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.workflowInstance.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getInstance(
    companyId: string,
    id: string,
  ): Promise<
    WorkflowInstance & {
      definition: WorkflowDefinition;
      currentState: WorkflowState | null;
      logs: Array<{
        id: string;
        kind: string;
        note: string | null;
        data: Prisma.JsonValue | null;
        createdAt: Date;
        actorUserId: string | null;
        transition: { code: string; name: string } | null;
      }>;
      timers: Array<{ id: string; timerType: string; status: TimerStatus; dueAt: Date }>;
      approvals: Array<{ id: string; approvalType: string; status: string; escalationLevel: number }>;
    }
  > {
    const instance = await this.prisma.workflowInstance.findFirst({
      where: { id, definition: { companyId } },
      include: {
        definition: true,
        currentState: true,
        logs: {
          orderBy: { createdAt: 'asc' },
          include: { transition: { select: { code: true, name: true } } },
        },
        timers: { orderBy: { dueAt: 'asc' } },
        approvals: {
          orderBy: { createdAt: 'desc' },
          select: { id: true, approvalType: true, status: true, escalationLevel: true },
        },
      },
    });
    if (!instance) throw new NotFoundError('Workflow instance not found', { id });
    return instance;
  }

  /**
   * Execute an available transition. Approval-gated transitions park the
   * instance (PENDING ApprovalRequest + optional SLA escalation timer);
   * plain transitions flip the state with an optimistic version guard.
   */
  async executeTransition(
    companyId: string,
    instanceId: string,
    input: { transitionCode: string; note?: string },
    actor: WorkflowActor,
    effectivePermissions: ReadonlySet<string>,
    ctx: RequestContext,
  ): Promise<
    | { outcome: 'EXECUTED'; instance: WorkflowInstance; completed: boolean }
    | { outcome: 'APPROVAL_REQUESTED'; instance: WorkflowInstance; approval: ApprovalRequest }
  > {
    const instance = await this.prisma.workflowInstance.findFirst({
      where: { id: instanceId, definition: { companyId } },
      include: { definition: true, currentState: true },
    });
    if (!instance) throw new NotFoundError('Workflow instance not found', { id: instanceId });
    if (instance.status !== 'ACTIVE') {
      throw new ConflictError(WORKFLOW_MESSAGES.instanceNotActive, { status: instance.status });
    }
    const transition = await this.prisma.workflowTransition.findFirst({
      where: { definitionId: instance.definitionId, code: input.transitionCode },
    });
    if (
      !transition ||
      !instance.currentStateId ||
      transition.fromStateId !== instance.currentStateId
    ) {
      throw new NotFoundError(WORKFLOW_MESSAGES.transitionNotAvailable, {
        transitionCode: input.transitionCode,
        currentState: instance.currentState?.code ?? null,
      });
    }
    if (
      transition.requiredPermission &&
      !effectivePermissions.has(transition.requiredPermission)
    ) {
      throw new ForbiddenError(WORKFLOW_MESSAGES.transitionPermissionRequired, {
        required: transition.requiredPermission,
      });
    }
    const condition = transition.conditionJson as ConditionNode | null;
    const context = (instance.context ?? {}) as Record<string, unknown>;
    if (!evaluateCondition(condition, context)) {
      throw new ValidationError(WORKFLOW_MESSAGES.conditionNotMet, {
        transitionCode: transition.code,
      });
    }
    if (transition.requiresApproval) {
      const approval = await this.requestApprovalForTransition(
        companyId, instance, transition, actor, ctx, input.note,
      );
      return { outcome: 'APPROVAL_REQUESTED', instance, approval };
    }

    const { instance: updated, completed } = await this.applyTransition(
      companyId, instance, transition, actor, ctx, input.note,
    );
    return { outcome: 'EXECUTED', instance: updated, completed };
  }

  /** Approval gate: create the PENDING request atomically with its log; timer after commit. */
  private async requestApprovalForTransition(
    companyId: string,
    instance: WorkflowInstance & { definition: WorkflowDefinition },
    transition: WorkflowTransition,
    actor: WorkflowActor,
    ctx: RequestContext,
    note?: string,
  ): Promise<ApprovalRequest> {
    const pending = await this.prisma.approvalRequest.findFirst({
      where: {
        companyId,
        entityType: WORKFLOW_APPROVAL_ENTITY_TYPE,
        entityId: instance.id,
        status: 'PENDING',
      },
      select: { id: true },
    });
    if (pending) {
      throw new ConflictError(WORKFLOW_MESSAGES.approvalPending, { approvalId: pending.id });
    }
    const dueAt = transition.slaHours && transition.slaHours > 0
      ? new Date(Date.now() + transition.slaHours * 3_600_000)
      : undefined;

    const result = await this.prisma.$transaction(async (tx) => {
      const approval = await this.approvals.createForWorkflow(tx, {
        companyId,
        workflowInstanceId: instance.id,
        approvalType: transition.approvalType ?? transition.code,
        requestedById: actor.id,
        reason: note,
        dueAt,
      });
      await tx.workflowExecutionLog.create({
        data: {
          instanceId: instance.id,
          kind: 'APPROVAL_REQUESTED',
          transitionId: transition.id,
          fromStateId: instance.currentStateId,
          actorUserId: actor.id,
          note,
          data: {
            approvalId: approval.id,
            transitionCode: transition.code,
          } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'workflow_instance',
        entityId: instance.id,
        action: 'WORKFLOW_APPROVAL_REQUESTED',
        companyId,
        actor,
        newValues: { transitionCode: transition.code, approvalId: approval.id },
        reason: note,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      let escalationTimerId: string | null = null;
      if (transition.slaHours && transition.slaHours > 0) {
        const timer = await tx.workflowTimer.create({
          data: {
            workflowInstanceId: instance.id,
            stateId: instance.currentStateId!,
            timerType: 'ESCALATION',
            dueAt: dueAt as Date,
            status: 'SCHEDULED',
            actionConfig: {
              action: 'approval_escalate',
              transitionCode: transition.code,
              approvalType: approval.approvalType,
              title: `تأیید معطل: ${instance.definition.name}`,
            } as Prisma.InputJsonValue,
          },
        });
        escalationTimerId = timer.id;
      }
      return { approval, escalationTimerId };
    });

    // Approver + escalation delivery after commit (best effort, never
    // un-requests the approval).
    await this.notifyRoles(
      companyId,
      ['sales_manager', 'admin'],
      {
        title: 'درخواست تایید گردش کار',
        body: `انتقال «${transition.name}» نیازمند تایید شماست.`,
        relatedEntityType: WORKFLOW_APPROVAL_ENTITY_TYPE,
        relatedEntityId: instance.id,
        priority: 'HIGH',
      },
    ).catch((error) =>
      this.logger.warn(`Approver notification failed for instance ${instance.id}: ${String(error)}`),
    );
    if (result.escalationTimerId) {
      await this.queue
        .enqueue({
          jobType: 'workflow.timer',
          companyId,
          payload: { timerId: result.escalationTimerId },
          idempotencyKey: `workflow-timer:${result.escalationTimerId}`,
          delayMs: Math.max(0, (dueAt?.getTime() ?? Date.now()) - Date.now()),
          maxAttempts: 3,
        })
        .catch((error) =>
          this.logger.warn(`Escalation timer enqueue failed for instance ${instance.id}: ${String(error)}`),
        );
    }
    return result.approval;
  }

  /**
   * State flip with optimistic concurrency: the conditional updateMany on
   * (id, version, status=ACTIVE) makes exactly one of two simultaneous
   * transitions win; the loser reconciles with 409
   * WORKFLOW_CONCURRENT_MODIFICATION. Final states complete the instance in
   * the same atomic flip. System resumption passes actor=null (log keeps
   * actorUserId null; audit records the system actor).
   */
  private async applyTransition(
    companyId: string,
    instance: WorkflowInstance,
    transition: WorkflowTransition,
    actor: WorkflowActor | null,
    ctx: RequestContext,
    note?: string,
  ): Promise<{ instance: WorkflowInstance; completed: boolean }> {
    const toState = await this.prisma.workflowState.findUniqueOrThrow({
      where: { id: transition.toStateId },
    });
    const result = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.workflowInstance.updateMany({
        where: { id: instance.id, version: instance.version, status: 'ACTIVE' },
        data: {
          currentStateId: transition.toStateId,
          version: { increment: 1 },
          ...(toState.isFinal ? { status: 'COMPLETED' } : {}),
        },
      });
      if (flipped.count !== 1) {
        throw new ConflictError(WORKFLOW_MESSAGES.concurrentModification, { id: instance.id });
      }
      const updated = await tx.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
      await tx.workflowExecutionLog.create({
        data: {
          instanceId: instance.id,
          kind: 'TRANSITION',
          transitionId: transition.id,
          fromStateId: transition.fromStateId,
          toStateId: transition.toStateId,
          actorUserId: actor?.id ?? null,
          note,
          data: {
            transitionCode: transition.code,
            completed: toState.isFinal,
          } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'workflow_instance',
        entityId: instance.id,
        action: toState.isFinal ? 'WORKFLOW_INSTANCE_COMPLETED' : 'WORKFLOW_TRANSITION_EXECUTED',
        companyId,
        actor: actor ?? { username: 'workflow-system' },
        oldValues: { stateId: transition.fromStateId, version: instance.version },
        newValues: { stateId: transition.toStateId, version: instance.version + 1 },
        reason: note,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { instance: updated, completed: toState.isFinal };
    });

    // Post-transition actions after commit (best effort, never un-applies).
    const actions = (transition.actionsJson ?? []) as unknown as WorkflowActionConfig[];
    for (const action of actions) {
      if (action.type === 'notify' && action.roles?.length) {
        await this.notifyRoles(companyId, action.roles, {
          title: action.title ?? `گردش کار: ${transition.name}`,
          body: action.body,
          relatedEntityType: instance.entityType,
          relatedEntityId: instance.entityId,
        }).catch((error) =>
          this.logger.warn(`Post-transition notify failed for ${instance.id}: ${String(error)}`),
        );
      }
    }
    return result;
  }

  /**
   * Decision-bus hook: resume an approval-gated transition. Idempotent —
   * an already-applied decision is a no-op; a failed first application is
   * retried through the durable `workflow.resume` queue job. The approval
   * decision itself is never rolled back by a resume failure.
   */
  async resumeAfterDecision(approval: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    if (approval.source !== 'WORKFLOW' || !approval.workflowInstanceId) return;
    try {
      await this.resumeOnce(approval, decision);
    } catch (error) {
      // Record the failure in the execution log, then hand recovery to the
      // durable queue (maxAttempts=3).
      await this.prisma
        .workflowExecutionLog.create({
          data: {
            instanceId: approval.workflowInstanceId,
            kind: 'FAILED',
            actorUserId: null,
            note: 'resume failed',
            data: { approvalId: approval.id, decision, error: String(error) } as Prisma.InputJsonValue,
          },
        })
        .catch(() => undefined);
      await this.queue
        .enqueue({
          jobType: 'workflow.resume',
          companyId: approval.companyId,
          payload: { approvalId: approval.id, decision },
          idempotencyKey: `workflow-resume:${approval.id}:${decision}`,
          maxAttempts: 3,
        })
        .catch((enqueueError) =>
          this.logger.error(
            `Resume retry enqueue failed for approval ${approval.id}: ${String(enqueueError)}`,
          ),
        );
    }
  }

  /** Queue retry entry point — same idempotency rules as the live resume. */
  async retryResume(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
    if (!approval || approval.status !== 'APPROVED' || approval.source !== 'WORKFLOW') return;
    await this.resumeOnce(approval, decision);
  }

  private async resumeOnce(approval: ApprovalRequest, decision: ApprovalDecision): Promise<void> {
    const instance = await this.prisma.workflowInstance.findUnique({
      where: { id: approval.workflowInstanceId! },
    });
    if (!instance || instance.status !== 'ACTIVE') return;

    if (decision === 'REJECTED') {
      await this.prisma.workflowExecutionLog.create({
        data: {
          instanceId: instance.id,
          kind: 'APPROVAL_DECIDED',
          actorUserId: approval.decidedBy,
          note: approval.decisionNote ?? undefined,
          data: { approvalId: approval.id, decision } as Prisma.InputJsonValue,
        },
      });
      // Instance stays ACTIVE at the same state; the transition may be
      // re-requested (a fresh approval) or the instance cancelled.
      return;
    }

    // APPROVED: find the parked transition from the APPROVAL_REQUESTED log.
    const requestLog = await this.prisma.workflowExecutionLog.findFirst({
      where: {
        instanceId: instance.id,
        kind: 'APPROVAL_REQUESTED',
        data: { path: ['approvalId'], equals: approval.id },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!requestLog?.transitionId) return;
    const alreadyApplied = await this.prisma.workflowExecutionLog.findFirst({
      where: {
        instanceId: instance.id,
        kind: 'TRANSITION',
        transitionId: requestLog.transitionId,
      },
      select: { id: true },
    });
    if (alreadyApplied) return; // idempotent resume
    const transition = await this.prisma.workflowTransition.findUnique({
      where: { id: requestLog.transitionId },
    });
    if (!transition) return;
    // Re-read the live row: the parked instance may have moved on since the
    // approval was requested (another path completed or cancelled it).
    const fresh = await this.prisma.workflowInstance.findUniqueOrThrow({
      where: { id: instance.id },
    });
    if (fresh.currentStateId !== transition.fromStateId || fresh.status !== 'ACTIVE') {
      await this.prisma.workflowExecutionLog.create({
        data: {
          instanceId: instance.id,
          kind: 'APPROVAL_DECIDED',
          actorUserId: approval.decidedBy,
          note: 'تایید پس از تغییر وضعیت — انتقال اعمال نشد',
          data: { approvalId: approval.id, decision } as Prisma.InputJsonValue,
        },
      });
      return;
    }
    await this.applyTransition(
      approval.companyId, fresh, transition, null, {}, approval.decisionNote ?? undefined,
    );
    await this.prisma.workflowExecutionLog.create({
      data: {
        instanceId: instance.id,
        kind: 'APPROVAL_DECIDED',
        actorUserId: approval.decidedBy,
        note: approval.decisionNote ?? undefined,
        data: { approvalId: approval.id, decision, resumed: true } as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Cancel an ACTIVE instance: flips status, cancels its SCHEDULED timers
   * and PENDING workflow approvals — all atomically with the audit row.
   * Allowed to the starter or a workflow.admin holder.
   */
  async cancelInstance(
    companyId: string,
    id: string,
    actor: WorkflowActor,
    canAdmin: boolean,
    ctx: RequestContext,
    reason?: string,
  ): Promise<WorkflowInstance> {
    const instance = await this.prisma.workflowInstance.findFirst({
      where: { id, definition: { companyId } },
    });
    if (!instance) throw new NotFoundError('Workflow instance not found', { id });
    if (!canAdmin && instance.createdBy !== actor.id) {
      throw new ForbiddenError(WORKFLOW_MESSAGES.cancelForbidden, { id });
    }
    const pendingApprovals = await this.prisma.approvalRequest.findMany({
      where: { workflowInstanceId: instance.id, status: 'PENDING' },
      select: { id: true },
    });
    const cancelled = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.workflowInstance.updateMany({
        where: { id: instance.id, status: 'ACTIVE' },
        data: { status: 'CANCELLED' },
      });
      if (flipped.count !== 1) {
        throw new ConflictError(WORKFLOW_MESSAGES.instanceNotActive, { status: instance.status });
      }
      const timers = await tx.workflowTimer.updateMany({
        where: { workflowInstanceId: instance.id, status: 'SCHEDULED' },
        data: { status: 'CANCELLED' },
      });
      for (const approval of pendingApprovals) {
        await tx.approvalRequest.update({
          where: { id: approval.id },
          data: { status: 'CANCELLED' },
        });
        await tx.approvalEvent.create({
          data: {
            requestId: approval.id,
            kind: 'CANCELLED',
            actorUserId: actor.id,
            note: 'گردش کار لغو شد',
          },
        });
      }
      await tx.workflowExecutionLog.create({
        data: {
          instanceId: instance.id,
          kind: 'CANCELLED',
          actorUserId: actor.id,
          note: reason,
          data: {
            cancelledTimers: timers.count,
            cancelledApprovals: pendingApprovals.length,
          } as Prisma.InputJsonValue,
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'workflow_instance',
        entityId: instance.id,
        action: 'WORKFLOW_INSTANCE_CANCELLED',
        companyId,
        actor,
        oldValues: { status: 'ACTIVE' },
        newValues: { status: 'CANCELLED' },
        reason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return tx.workflowInstance.findUniqueOrThrow({ where: { id: instance.id } });
    });

    // Best-effort queue cleanup: due jobs no-op on CANCELLED timers anyway.
    const cancelledTimers = await this.prisma.workflowTimer.findMany({
      where: { workflowInstanceId: instance.id, status: 'CANCELLED' },
      select: { id: true },
    });
    for (const timer of cancelledTimers) {
      await this.prisma.queueJob
        .findFirst({
          where: { companyId, idempotencyKey: `workflow-timer:${timer.id}` },
          select: { id: true },
        })
        .then((job) => (job ? this.queue.cancel(job.id) : undefined))
        .catch(() => undefined);
    }
    return cancelled;
  }

  /** Timer action: SLA reminder for a state (approval-less reminder). */
  private handleStateSla = async (
    config: Record<string, unknown>,
    ctx: WorkflowTimerActionContext,
  ): Promise<void> => {
    const instance = await this.prisma.workflowInstance.findUnique({
      where: { id: ctx.workflowInstanceId },
      select: { id: true, status: true },
    });
    if (!instance || instance.status !== 'ACTIVE') return;
    const recipients = Array.isArray(config.roles) ? (config.roles as string[]) : ['sales_manager'];
    await ctx.notifications
      .resolveRecipients(ctx.companyId, recipients.map((role) => ({ type: 'ROLE' as const, value: role })), {})
      .then((userIds) =>
        userIds.length
          ? ctx.notifications.createNotifications(userIds, {
              companyId: ctx.companyId,
              title: typeof config.title === 'string' ? config.title : 'یادآوری گردش کار',
              relatedEntityType: ctx.entityType,
              relatedEntityId: ctx.entityId,
            })
          : undefined,
      )
      .catch((error) =>
        this.logger.warn(`state_sla notification failed for ${ctx.entityId}: ${String(error)}`),
      );
    await this.prisma.workflowExecutionLog.create({
      data: {
        instanceId: instance.id,
        kind: 'TIMER_FIRED',
        actorUserId: null,
        note: 'یادآوری SLA مرحله',
        data: { stateCode: config.stateCode ?? null } as Prisma.InputJsonValue,
      },
    });
  };

  /**
   * Timer action: escalate a parked approval-gated transition. No pending
   * approval → the instance moved on → no-op. The level bump is guarded on
   * status=PENDING so a racing decision + timer cannot double-escalate.
   */
  private handleApprovalEscalation = async (
    config: Record<string, unknown>,
    ctx: WorkflowTimerActionContext,
  ): Promise<void> => {
    const pending = await this.prisma.approvalRequest.findFirst({
      where: {
        companyId: ctx.companyId,
        entityType: WORKFLOW_APPROVAL_ENTITY_TYPE,
        entityId: ctx.workflowInstanceId,
        status: 'PENDING',
      },
    });
    if (!pending) return;
    const recipients = Array.isArray(config.roles) ? (config.roles as string[]) : ['admin'];
    await ctx.notifications
      .resolveRecipients(ctx.companyId, recipients.map((role) => ({ type: 'ROLE' as const, value: role })), {})
      .then((userIds) =>
        userIds.length
          ? ctx.notifications.createNotifications(userIds, {
              companyId: ctx.companyId,
              title: typeof config.title === 'string' ? config.title : 'تأیید معطل شده (escalation)',
              body: `درخواست ${pending.approvalType} بیش از مهلت تعیین‌شده در انتظار تصمیم است.`,
              relatedEntityType: WORKFLOW_APPROVAL_ENTITY_TYPE,
              relatedEntityId: ctx.entityId,
              priority: 'HIGH',
            })
          : undefined,
      )
      .catch((error) =>
        this.logger.warn(`approval escalation notification failed for ${ctx.workflowInstanceId}: ${String(error)}`),
      );
    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.approvalRequest.updateMany({
        where: { id: pending.id, status: 'PENDING' },
        data: { escalationLevel: { increment: 1 } },
      });
      if (bumped.count !== 1) return;
      await tx.approvalEvent.create({
        data: {
          requestId: pending.id,
          kind: 'ESCALATED',
          actorUserId: null,
          note: 'زمان SLA تأیید به پایان رسید',
          data: { level: pending.escalationLevel + 1 } as Prisma.InputJsonValue,
        },
      });
      await tx.workflowExecutionLog.create({
        data: {
          instanceId: ctx.workflowInstanceId,
          kind: 'TIMER_FIRED',
          actorUserId: null,
          note: 'escalation تأیید',
          data: { approvalId: pending.id } as Prisma.InputJsonValue,
        },
      });
    });
  };
}

/** Queue handler `workflow.resume` — durable retry for failed resumes. */
@Injectable()
export class WorkflowResumeHandler {
  readonly type = 'workflow.resume';

  constructor(private readonly workflow: WorkflowService) {}

  async handle(payload: unknown): Promise<void> {
    const { approvalId, decision } = (payload ?? {}) as {
      approvalId?: string;
      decision?: ApprovalDecision;
    };
    if (typeof approvalId !== 'string' || (decision !== 'APPROVED' && decision !== 'REJECTED')) {
      return;
    }
    await this.workflow.retryResume(approvalId, decision);
  }
}
