import { Injectable, Logger } from '@nestjs/common';
import { ApprovalRequest, ApprovalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { NotificationService } from '../notifications/notifications.service';
import { ApprovalDecisionBus, ApprovalDecision } from './approval-decision.bus';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { ApprovalQueryDto, CreateApprovalDto } from './approvals.dto';

export const APPROVAL_MESSAGES = {
  alreadyDecided: 'APPROVAL_ALREADY_DECIDED',
  unknownEntityType: 'APPROVAL_UNKNOWN_ENTITY_TYPE',
  pendingExists: 'APPROVAL_PENDING_EXISTS',
  notCancellable: 'APPROVAL_NOT_CANCELLABLE',
  forbidden: 'APPROVAL_FORBIDDEN',
} as const;

/**
 * The extensible APPROVAL ENTITY map (Integrity Gate #13): ApprovalRequest
 * carries NO physical FK — (entityType, entityId) is a generic reference and
 * every producer registers its entity here so decisions can assert the
 * target actually exists IN THE COMPANY. Adding a new approvable entity is
 * a one-line map entry (next: purchase orders, claims, …).
 *
 * `workflow_instance` is deliberately ABSENT from the public map: workflow-
 * gated approvals are created internally by the workflow engine (source =
 * WORKFLOW) which validates its own instance; the generic create endpoint
 * rejects that type so users cannot forge engine approvals.
 */
export const APPROVAL_ENTITY_TYPES = ['loading', 'goods_receipt'] as const;
export type ApprovalEntityType = (typeof APPROVAL_ENTITY_TYPES)[number];
export const WORKFLOW_APPROVAL_ENTITY_TYPE = 'workflow_instance';

/** Viewer record-scope (mirrors the activities engine): scopeAll = decide/view_all. */
export interface ApprovalViewer {
  userId: string;
  scopeAll: boolean;
}

/**
 * Approval engine (Phase 6 lean + Phase 9B generalization, REQUIREMENTS §27):
 * single-decision requests usable for ANY registered entity type — the
 * loading debt gate (`RELEASE_DRIVER_INFO`), goods receipts, and workflow-
 * gated transitions. One PENDING request → one decision (APPROVED |
 * REJECTED | CANCELLED); re-deciding is a 409 decided by an atomic
 * `updateMany` guard, so two concurrent deciders can never both win.
 *
 * Every lifecycle mutation is audited ATOMICALLY with its ApprovalEvent
 * history row; the requester is notified after commit (best effort — a
 * failed notification never un-decides an approval). After a decision
 * commits, the ApprovalDecisionBus lets the workflow engine resume.
 */
@Injectable()
export class ApprovalRequestService {
  private readonly logger = new Logger('ApprovalRequestService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly notifications: NotificationService,
    private readonly decisionBus: ApprovalDecisionBus,
  ) {}

  async list(
    companyId: string,
    query: ApprovalQueryDto,
    viewer: ApprovalViewer,
  ): Promise<Paginated<ApprovalRequest>> {
    const where: Prisma.ApprovalRequestWhereInput = {
      companyId,
      status: query.status,
      approvalType: query.approvalType,
      entityType: query.entityType,
      // OWN scope: requesters see their own requests and requests routed to
      // them; decide/view_all holders see the whole company.
      ...(viewer.scopeAll
        ? {}
        : { OR: [{ requestedBy: viewer.userId }, { approverId: viewer.userId }] }),
    };
    const [items, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(
    companyId: string,
    id: string,
    viewer?: ApprovalViewer,
  ): Promise<ApprovalRequest & { events: Array<{ id: string; kind: string; note: string | null; createdAt: Date; actorUserId: string | null }> }> {
    const approval = await this.prisma.approvalRequest.findUnique({
      where: { id },
      include: {
        events: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, kind: true, note: true, createdAt: true, actorUserId: true },
        },
      },
    });
    if (!approval || approval.companyId !== companyId) {
      throw new NotFoundError('Approval request not found', { id });
    }
    if (viewer && !viewer.scopeAll) {
      const involved = approval.requestedBy === viewer.userId || approval.approverId === viewer.userId;
      if (!involved) throw new NotFoundError('Approval request not found', { id });
    }
    return approval;
  }

  /** The PENDING release request for a loading, if any (entityType='loading'). */
  async findPendingLoadingRelease(
    companyId: string,
    loadingId: string,
  ): Promise<ApprovalRequest | null> {
    return this.prisma.approvalRequest.findFirst({
      where: {
        companyId,
        entityType: 'loading',
        entityId: loadingId,
        approvalType: 'RELEASE_DRIVER_INFO',
        status: ApprovalStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Generic entity validation (Integrity Gate #13): the (entityType,
   * entityId) reference must point at an existing row IN THIS COMPANY.
   * Unknown type → 422 APPROVAL_UNKNOWN_ENTITY_TYPE; missing row → 404.
   */
  async assertEntityExists(
    companyId: string,
    entityType: string,
    entityId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    switch (entityType as string) {
      case 'loading': {
        const row = await db.loading.findFirst({ where: { id: entityId, companyId }, select: { id: true } });
        if (!row) throw new NotFoundError('Approval entity not found', { entityType, entityId });
        return;
      }
      case 'goods_receipt': {
        const row = await db.goodsReceipt.findFirst({ where: { id: entityId, companyId }, select: { id: true } });
        if (!row) throw new NotFoundError('Approval entity not found', { entityType, entityId });
        return;
      }
      case WORKFLOW_APPROVAL_ENTITY_TYPE: {
        const row = await db.workflowInstance.findFirst({
          where: { id: entityId, definition: { companyId } },
          select: { id: true },
        });
        if (!row) throw new NotFoundError('Approval entity not found', { entityType, entityId });
        return;
      }
      default:
        throw new ValidationError(APPROVAL_MESSAGES.unknownEntityType, { entityType });
    }
  }

  /**
   * Generic request creation (Phase 9B): any user holding approvals.request
   * (or approvals.decide) may request an approval for a registered entity.
   * Duplicate prevention is a DATABASE guarantee — the partial unique index
   * `approval_requests_one_pending_per_entity` rejects a second PENDING
   * request for the same (company, entity, type), including under concurrent
   * calls (P2002 → 409 APPROVAL_PENDING_EXISTS).
   */
  async create(
    companyId: string,
    input: CreateApprovalDto & { notifyRoles?: string[] },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<ApprovalRequest> {
    if (
      input.entityType === WORKFLOW_APPROVAL_ENTITY_TYPE ||
      !(APPROVAL_ENTITY_TYPES as readonly string[]).includes(input.entityType)
    ) {
      throw new ValidationError(APPROVAL_MESSAGES.unknownEntityType, { entityType: input.entityType });
    }
    await this.assertEntityExists(companyId, input.entityType, input.entityId);
    const dueAt = input.dueAt ? new Date(input.dueAt) : undefined;
    if (dueAt && !(dueAt.getTime() > Date.now())) {
      throw new ValidationError('APPROVAL_DUE_AT_MUST_BE_FUTURE', { dueAt: input.dueAt });
    }
    const notifyRoles = input.notifyRoles ?? ['sales_manager'];

    const created = await this.prisma.$transaction(async (tx) => {
      let approval;
      try {
        approval = await tx.approvalRequest.create({
          data: {
            companyId,
            entityType: input.entityType,
            entityId: input.entityId,
            approvalType: input.approvalType,
            requestedBy: actor.id,
            status: ApprovalStatus.PENDING,
            reason: input.reason,
            dueAt,
            source: 'MANUAL',
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictError(APPROVAL_MESSAGES.pendingExists, {
            entityType: input.entityType,
            entityId: input.entityId,
            approvalType: input.approvalType,
          });
        }
        throw error;
      }
      await tx.approvalEvent.create({
        data: {
          requestId: approval.id,
          kind: 'REQUESTED',
          actorUserId: actor.id,
          note: input.reason ?? null,
          data: { approvalType: input.approvalType, entityType: input.entityType } as Prisma.InputJsonValue,
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'approval_request',
        entityId: approval.id,
        action: 'APPROVAL_REQUESTED',
        companyId,
        actor,
        newValues: {
          entityType: approval.entityType,
          approvalType: approval.approvalType,
          entityId: approval.entityId,
        },
        reason: input.reason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return approval;
    });

    await this.notifyApprovers(companyId, created, notifyRoles);
    return created;
  }

  /**
   * Engine-internal creation (source=WORKFLOW): runs INSIDE the caller's
   * transaction so the approval commits atomically with the transition's
   * APPROVAL_REQUESTED log. Duplicate PENDING requests are impossible via
   * the same partial unique index (concurrent retries of the same
   * transition reconcile through P2002 → ConflictError).
   */
  async createForWorkflow(
    tx: Prisma.TransactionClient,
    input: {
      companyId: string;
      workflowInstanceId: string;
      approvalType: string;
      requestedById?: string;
      reason?: string;
      dueAt?: Date;
    },
  ): Promise<ApprovalRequest> {
    try {
      const approval = await tx.approvalRequest.create({
        data: {
          companyId: input.companyId,
          entityType: WORKFLOW_APPROVAL_ENTITY_TYPE,
          entityId: input.workflowInstanceId,
          approvalType: input.approvalType,
          requestedBy: input.requestedById,
          status: ApprovalStatus.PENDING,
          reason: input.reason,
          dueAt: input.dueAt,
          source: 'WORKFLOW',
          workflowInstanceId: input.workflowInstanceId,
        },
      });
      await tx.approvalEvent.create({
        data: {
          requestId: approval.id,
          kind: 'REQUESTED',
          actorUserId: input.requestedById ?? null,
          note: input.reason ?? null,
          data: { approvalType: input.approvalType, source: 'WORKFLOW' } as Prisma.InputJsonValue,
        },
      });
      return approval;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError(APPROVAL_MESSAGES.pendingExists, { workflowInstanceId: input.workflowInstanceId });
      }
      throw error;
    }
  }

  private async notifyApprovers(
    companyId: string,
    approval: ApprovalRequest,
    roles: string[],
  ): Promise<void> {
    const recipients = roles.filter((r) => typeof r === 'string' && r.length > 0);
    if (recipients.length === 0) return;
    try {
      const userIds = await this.notifications.resolveRecipients(
        companyId,
        recipients.map((role) => ({ type: 'ROLE' as const, value: role })),
        {},
      );
      if (userIds.length === 0) return;
      await this.notifications.createNotifications(userIds, {
        companyId,
        title: 'درخواست تایید جدید',
        body: `درخواست ${approval.approvalType} ثبت شد و در انتظار تصمیم است.`,
        relatedEntityType: approval.entityType,
        relatedEntityId: approval.entityId,
        priority: 'HIGH',
      });
    } catch (error) {
      this.logger.warn(`Approver notification failed for ${approval.id}: ${String(error)}`);
    }
  }

  /**
   * Cancel a PENDING request: the requester (or a decide holder) withdraws
   * it. Atomic: status flip + ApprovalEvent + audit commit together.
   */
  async cancel(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    canDecide: boolean,
    ctx: RequestContext,
    reason?: string,
  ): Promise<ApprovalRequest> {
    const existing = await this.getById(companyId, id);
    if (!canDecide && existing.requestedBy !== actor.id) {
      throw new ForbiddenError(APPROVAL_MESSAGES.forbidden, { id });
    }
    if (existing.status !== ApprovalStatus.PENDING) {
      throw new ConflictError(APPROVAL_MESSAGES.notCancellable, { id, status: existing.status });
    }
    return this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.approvalRequest.update({
        where: { id: existing.id },
        data: { status: ApprovalStatus.CANCELLED },
      });
      await tx.approvalEvent.create({
        data: {
          requestId: cancelled.id,
          kind: 'CANCELLED',
          actorUserId: actor.id,
          note: reason ?? null,
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'approval_request',
        entityId: cancelled.id,
        action: 'APPROVAL_CANCELLED',
        companyId,
        actor,
        oldValues: { status: existing.status },
        newValues: { status: cancelled.status },
        reason,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return cancelled;
    });
  }

  /**
   * Decide a PENDING request (APPROVED | REJECTED). Concurrency: the flip is
   * an atomic conditional updateMany on status=PENDING — two simultaneous
   * deciders reconcile (exactly one wins, the loser gets 409). Atomic:
   * decision + ApprovalEvent + audit (+ the loading driver-info release +
   * its timeline event) commit together; the requester notification and the
   * decision bus follow the commit (best effort — a failed notification
   * never un-decides an approval).
   */
  async decide(
    companyId: string,
    id: string,
    input: { decision: ApprovalDecision; note?: string },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<ApprovalRequest> {
    const existing = await this.getById(companyId, id);
    if (existing.status !== ApprovalStatus.PENDING) {
      throw new ConflictError(APPROVAL_MESSAGES.alreadyDecided, {
        id,
        status: existing.status,
      });
    }
    // The generic reference must resolve (Integrity Gate #13) — a decision
    // on a deleted/foreign entity can never commit.
    await this.assertEntityExists(companyId, existing.entityType, existing.entityId);

    const decision = await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.approvalRequest.updateMany({
        where: { id: existing.id, status: ApprovalStatus.PENDING },
        data: {
          status: input.decision,
          decidedBy: actor.id,
          decidedAt: new Date(),
          decisionNote: input.note,
          approverId: actor.id,
        },
      });
      if (flipped.count !== 1) {
        // Concurrent decide already flipped it.
        throw new ConflictError(APPROVAL_MESSAGES.alreadyDecided, { id });
      }
      const approval = await tx.approvalRequest.findUniqueOrThrow({ where: { id: existing.id } });

      await tx.approvalEvent.create({
        data: {
          requestId: approval.id,
          kind: 'DECIDED',
          actorUserId: actor.id,
          note: input.note ?? null,
          data: { decision: input.decision } as Prisma.InputJsonValue,
        },
      });

      // Loading debt-gate effect: APPROVED releases the restricted driver /
      // carrier info (REJECTED keeps it restricted — nothing to do).
      if (
        approval.entityType === 'loading' &&
        approval.approvalType === 'RELEASE_DRIVER_INFO' &&
        input.decision === 'APPROVED'
      ) {
        const loading = await tx.loading.update({
          where: { id: approval.entityId },
          data: { driverInfoRestricted: false },
          select: { id: true, customerPartyId: true },
        });
        if (loading.customerPartyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: loading.customerPartyId,
            type: 'DRIVER_INFO_RELEASED',
            title: 'انتشار اطلاعات راننده',
            description: 'اطلاعات راننده/باربری با تایید مدیر منتشر شد',
            data: { loadingId: loading.id, approvalId: approval.id },
            actorUserId: actor.id,
          });
        }
      }

      await this.auditService.recordTx(tx, {
        entityType: 'approval_request',
        entityId: approval.id,
        action: input.decision === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
        companyId,
        actor,
        oldValues: { status: existing.status },
        newValues: { status: approval.status, entityType: approval.entityType, approvalType: approval.approvalType },
        reason: input.note,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return approval;
    });

    if (decision.requestedBy) {
      await this.notifications.createNotifications([decision.requestedBy], {
        companyId,
        title: input.decision === 'APPROVED' ? 'تایید درخواست' : 'رد درخواست',
        body:
          input.decision === 'APPROVED'
            ? `درخواست ${decision.approvalType} تایید شد.`
            : `درخواست ${decision.approvalType} رد شد.`,
        relatedEntityType: decision.entityType,
        relatedEntityId: decision.entityId,
      });
    }
    // Downstream automations (workflow resume). Committed-decision contract:
    // the bus never throws outwards and never un-decides.
    await this.decisionBus.emit(decision, input.decision);
    return decision;
  }
}
