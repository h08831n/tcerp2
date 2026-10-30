import { Injectable } from '@nestjs/common';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { Prisma, ActivityPriority, ActivityStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../parties/timeline.service';
import { AuditService } from '../audit/audit.service';
import type { ActivityActor, CreateActivityInput, UpdateActivityInput, ActivityListFilters } from './activity.types';

type Tx = Prisma.TransactionClient | PrismaService;

const ALLOWED_RELATED_TYPES = new Set([
  'party',
  'lead',
  'opportunity',
  'sales_document',
  'purchase_document',
  'price_request',
  'loading',
  'payment',
  'check',
  'tax_invoice',
  'approval_request',
]);

export class ActivityAccessDeniedError extends Error {}

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
  ) {}

  private async assertAssigneeInCompany(companyId: string, userId: string): Promise<void> {
    const member = await this.prisma.userCompanyRole.findFirst({
      where: { userId, companyId },
      select: { roleId: true },
    });
    if (!member) throw new ValidationError('ACTIVITY_ASSIGNEE_NOT_IN_COMPANY', { userId });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { status: true } });
    if (!user || user.status !== 'ACTIVE') {
      throw new ValidationError('ACTIVITY_ASSIGNEE_INACTIVE', { userId });
    }
  }

  async listTypes(companyId: string) {
    return this.prisma.activityType.findMany({
      where: { companyId, active: true },
      orderBy: { nameFa: 'asc' },
      select: { id: true, code: true, nameFa: true, color: true },
    });
  }

  async createType(companyId: string, input: { code: string; nameFa: string; color?: string }, actor: ActivityActor) {
    const existing = await this.prisma.activityType.findUnique({
      where: { companyId_code: { companyId, code: input.code } },
    });
    if (existing) throw new ConflictError('ACTIVITY_TYPE_CODE_EXISTS', { code: input.code });
    let created!: { id: string; code: string; nameFa: string; color: string | null; active: boolean };
    await this.prisma.$transaction(async (tx) => {
      created = await tx.activityType.create({
        data: { companyId, code: input.code.trim(), nameFa: input.nameFa.trim(), color: input.color ?? null },
      });
      await this.audit.recordTx(tx, {
        entityType: 'activity_type',
        entityId: created.id,
        action: 'CREATE',
        companyId,
        actor,
        newValues: { code: created.code, nameFa: created.nameFa },
      });
    });
    return created;
  }

  async create(companyId: string, input: CreateActivityInput, actor: ActivityActor, actorType: 'USER' | 'SYSTEM' = 'USER'): Promise<{ id: string }> {
    const type = await this.resolveType(companyId, input.typeCode);
    if (!ALLOWED_RELATED_TYPES.has(input.relatedEntityType)) {
      throw new ValidationError('ACTIVITY_RELATED_ENTITY_TYPE_INVALID', { relatedEntityType: input.relatedEntityType });
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new ValidationError('ACTIVITY_TITLE_REQUIRED');
    }
    if (input.assignedToId) await this.assertAssigneeInCompany(companyId, input.assignedToId);
    let createdId = '';
    await this.prisma.$transaction(async (tx) => {
      const activity = await tx.activity.create({
        data: {
          companyId,
          typeId: type.id,
          title: input.title.trim(),
          description: input.description,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
          createdByType: actorType,
          createdById: actorType === 'USER' ? actor.id : null,
          assignedToId: input.assignedToId ?? null,
          priority: input.priority ?? 'NORMAL',
          scheduledDate: input.scheduledDate ?? null,
          dueDate: input.dueDate ?? null,
        },
      });
      createdId = activity.id;
      await this.timeline.record(tx, {
        companyId,
        entityType: input.relatedEntityType,
        entityId: input.relatedEntityId,
        type: 'ACTIVITY_CREATED',
        title: `فعالیت: ${activity.title}`,
        description: input.description,
        data: { activityId: activity.id, typeCode: input.typeCode },
        actorType,
        actorUserId: actorType === 'USER' ? actor.id : null,
      });
      await this.audit.recordTx(tx, {
        entityType: 'activity',
        entityId: activity.id,
        action: 'CREATE',
        companyId,
        actor,
        newValues: { title: activity.title, typeCode: input.typeCode, dueDate: input.dueDate ?? null },
      });
    });
    return { id: createdId };
  }

  async getById(companyId: string, id: string, viewer?: { userId: string; scopeAll: boolean }) {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id,
        companyId,
        ...(viewer && !viewer.scopeAll
          ? { OR: [{ assignedToId: viewer.userId }, { createdById: viewer.userId }] }
          : {}),
      },
      include: {
        type: { select: { code: true, nameFa: true, color: true } },
        assignedTo: { select: { id: true, username: true, firstName: true, lastName: true } },
        completedBy: { select: { id: true, username: true } },
      },
    });
    if (!activity) throw new NotFoundError('Activity not found', { id });
    return this.withDerived(activity);
  }

  async list(companyId: string, filters: ActivityListFilters) {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(Math.max(filters.pageSize ?? 20, 1), 100);
    const now = new Date();
    const where: Prisma.ActivityWhereInput = {
      companyId,
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.priority ? { priority: filters.priority } : {}),
      ...(filters.assignedToId ? { assignedToId: filters.assignedToId } : {}),
      ...(filters.relatedEntityType && filters.relatedEntityId
        ? { relatedEntityType: filters.relatedEntityType, relatedEntityId: filters.relatedEntityId }
        : {}),
      ...(filters.typeCode ? { type: { code: filters.typeCode } } : {}),
      ...(filters.dueFrom || filters.dueTo
        ? { dueDate: { ...(filters.dueFrom ? { gte: filters.dueFrom } : {}), ...(filters.dueTo ? { lte: filters.dueTo } : {}) } }
        : {}),
      ...(filters.overdueOnly
        ? { status: 'PENDING' as ActivityStatus, dueDate: { lt: now, not: null } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.activity.findMany({
        where,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          type: { select: { code: true, nameFa: true, color: true } },
          assignedTo: { select: { id: true, username: true, firstName: true, lastName: true } },
        },
      }),
      this.prisma.activity.count({ where }),
    ]);
    return {
      items: items.map((a) => this.withDerived(a)),
      total,
      page,
      pageSize,
    };
  }

  async update(
    companyId: string,
    id: string,
    input: UpdateActivityInput & { overrideReason?: string },
    actor: ActivityActor,
    canOverride: boolean,
    viewer?: { userId: string; scopeAll: boolean },
  ): Promise<void> {
    const activity = await this.mustGetScoped(companyId, id, viewer);
    const isCompleted = activity.status !== 'PENDING';
    if (isCompleted) {
      if (!canOverride) throw new ValidationError('ACTIVITY_LOCKED_OVERRIDE_REQUIRED', { status: activity.status });
      if (!input.overrideReason || input.overrideReason.trim().length < 3) {
        throw new ValidationError('ACTIVITY_OVERRIDE_REASON_REQUIRED');
      }
    }
    if (input.assignedToId) await this.assertAssigneeInCompany(companyId, input.assignedToId);
    await this.prisma.$transaction(async (tx) => {
      await tx.activity.update({
        where: { id },
        data: {
          ...(input.title !== undefined ? { title: input.title.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.assignedToId !== undefined ? { assignedToId: input.assignedToId } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.scheduledDate !== undefined ? { scheduledDate: input.scheduledDate } : {}),
          ...(input.dueDate !== undefined ? { dueDate: input.dueDate } : {}),
          ...(isCompleted
            ? { lastOverrideById: actor.id, lastOverrideReason: input.overrideReason!.trim() }
            : {}),
        },
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: activity.relatedEntityType,
        entityId: activity.relatedEntityId,
        type: isCompleted ? 'ACTIVITY_OVERRIDDEN' : 'ACTIVITY_UPDATED',
        title: isCompleted ? `ویرایش فعالیت تکمیل‌شده: ${activity.title}` : `ویرایش فعالیت: ${activity.title}`,
        data: {
          activityId: id,
          changes: { ...input, overrideReason: isCompleted ? input.overrideReason : undefined },
        },
        actorUserId: actor.id,
      });
      await this.audit.recordTx(tx, {
        entityType: 'activity',
        entityId: id,
        action: isCompleted ? 'OVERRIDE_UPDATE' : 'UPDATE',
        companyId,
        actor,
        oldValues: { title: activity.title, status: activity.status },
        newValues: { ...input },
        reason: isCompleted ? input.overrideReason : undefined,
      });
    });
  }

  async complete(companyId: string, id: string, actor: ActivityActor, note?: string, viewer?: { userId: string; scopeAll: boolean }): Promise<void> {
    const activity = await this.mustGetScoped(companyId, id, viewer);
    if (activity.status !== 'PENDING') {
      throw new ConflictError('ACTIVITY_ALREADY_COMPLETED', { status: activity.status });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.activity.update({
        where: { id },
        data: { status: 'COMPLETED', completedAt: new Date(), completedById: actor.id },
      });
      const dedup = await tx.timelineEvent.findFirst({
        where: {
          companyId,
          entityType: activity.relatedEntityType,
          entityId: activity.relatedEntityId,
          type: 'ACTIVITY_COMPLETED',
          data: { path: ['activityId'], equals: id },
        },
        select: { id: true },
      });
      if (!dedup) {
        await this.timeline.record(tx, {
          companyId,
          entityType: activity.relatedEntityType,
          entityId: activity.relatedEntityId,
          type: 'ACTIVITY_COMPLETED',
          title: `تکمیل فعالیت: ${activity.title}`,
          description: note ?? activity.description ?? undefined,
          data: { activityId: id, typeCode: activity.type.code },
          actorUserId: actor.id,
        });
      }
      await this.audit.recordTx(tx, {
        entityType: 'activity',
        entityId: id,
        action: 'COMPLETE',
        companyId,
        actor,
        newValues: { completedAt: new Date().toISOString(), note: note ?? null },
      });
    });
  }

  async cancel(companyId: string, id: string, actor: ActivityActor, reason: string, viewer?: { userId: string; scopeAll: boolean }): Promise<void> {
    const activity = await this.mustGetScoped(companyId, id, viewer);
    if (activity.status !== 'PENDING') {
      throw new ConflictError('ACTIVITY_ALREADY_COMPLETED', { status: activity.status });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.activity.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.audit.recordTx(tx, {
        entityType: 'activity',
        entityId: id,
        action: 'CANCEL',
        companyId,
        actor,
        reason,
      });
    });
  }

  async delete(companyId: string, id: string, actor: ActivityActor, viewer?: { userId: string; scopeAll: boolean }): Promise<void> {
    const activity = await this.mustGetScoped(companyId, id, viewer);
    if (activity.status === 'COMPLETED') {
      throw new ConflictError('ACTIVITY_COMPLETED_NOT_DELETABLE', { status: activity.status });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.activity.delete({ where: { id } });
      await this.audit.recordTx(tx, {
        entityType: 'activity',
        entityId: id,
        action: 'DELETE',
        companyId,
        actor,
        oldValues: { title: activity.title, status: activity.status },
      });
    });
  }

  private async mustGetScoped(
    companyId: string,
    id: string,
    viewer?: { userId: string; scopeAll: boolean },
  ) {
    const activity = await this.prisma.activity.findFirst({
      where: {
        id,
        companyId,
        ...(viewer && !viewer.scopeAll
          ? { OR: [{ assignedToId: viewer.userId }, { createdById: viewer.userId }] }
          : {}),
      },
      include: { type: { select: { code: true } } },
    });
    if (!activity) throw new NotFoundError('Activity not found', { id });
    return activity;
  }

  private async resolveType(companyId: string, code: string) {
    const type = await this.prisma.activityType.findUnique({
      where: { companyId_code: { companyId, code } },
    });
    if (!type || !type.active) throw new NotFoundError('Activity type not found', { code });
    return type;
  }
  /** Activity types are DYNAMIC (REQUIREMENTS 49): SYSTEM flows auto-provision
   *  unknown codes so automation rules never fail on type setup. */
  private async ensureType(companyId: string, code: string) {
    const existing = await this.prisma.activityType.findUnique({
      where: { companyId_code: { companyId, code } },
    });
    if (existing) return existing;
    return this.prisma.activityType.create({
      data: { companyId, code: code.trim(), nameFa: code.trim() },
    });
  }

  private withDerived<
    T extends { status: ActivityStatus; dueDate: Date | null; priority: ActivityPriority },
  >(activity: T): T & { overdue: boolean } {
    return {
      ...activity,
      overdue: activity.status === 'PENDING' && !!activity.dueDate && activity.dueDate.getTime() < Date.now(),
    };
  }

  /** SYSTEM creation (Workflow/Automation §53): idempotent per (company, uid,
   *  relatedEntity) — a repeated automation trigger does not duplicate. */
  async createSystemActivity(companyId: string, input: CreateActivityInput & { idempotencyKey: string }): Promise<{ activityId: string; created: boolean }> {
    const type = await this.ensureType(companyId, input.typeCode);
    if (!ALLOWED_RELATED_TYPES.has(input.relatedEntityType)) {
      throw new ValidationError('ACTIVITY_RELATED_ENTITY_TYPE_INVALID', { relatedEntityType: input.relatedEntityType });
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new ValidationError('ACTIVITY_TITLE_REQUIRED');
    }
    // DB-enforced idempotency (correction gate P1): unique(companyId,
    // idempotencyKey) — a fast pre-check avoids the error in the common
    // sequential case; the constraint settles concurrent duplicates.
    const existing = await this.prisma.activity.findUnique({
      where: { companyId_idempotencyKey: { companyId, idempotencyKey: input.idempotencyKey } },
      select: { id: true },
    });
    if (existing) return { activityId: existing.id, created: false };
    let activityId = '';
    try {
      await this.prisma.$transaction(async (tx) => {
        const activity = await tx.activity.create({
          data: {
            companyId,
            typeId: type.id,
            title: input.title.trim(),
            description: input.description,
            relatedEntityType: input.relatedEntityType,
            relatedEntityId: input.relatedEntityId,
            createdByType: 'SYSTEM',
            createdById: null,
            assignedToId: input.assignedToId ?? null,
            priority: input.priority ?? 'NORMAL',
            scheduledDate: input.scheduledDate ?? null,
            dueDate: input.dueDate ?? null,
            idempotencyKey: input.idempotencyKey,
          },
        });
        activityId = activity.id;
        await this.timeline.record(tx, {
          companyId,
          entityType: input.relatedEntityType,
          entityId: input.relatedEntityId,
          type: 'ACTIVITY_CREATED',
          title: `فعالیت: ${input.title}`,
          description: input.description,
          data: { activityId: activity.id, typeCode: input.typeCode, source: 'SYSTEM' },
          actorType: 'SYSTEM',
          actorUserId: null,
        });
      });
    } catch (error) {
      // concurrent duplicate: another writer registered the same key — return
      // the persisted activity instead of surfacing a constraint error
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const settled = await this.prisma.activity.findUniqueOrThrow({
          where: { companyId_idempotencyKey: { companyId, idempotencyKey: input.idempotencyKey } },
          select: { id: true },
        });
        return { activityId: settled.id, created: false };
      }
      throw error;
    }
    return { activityId, created: true };
  }

  /** Central calendar (REQUIREMENTS §56): merged, company-scoped layers over
   *  the requested range. The activities layer is authoritative here; the
   *  checks/payments/approvals layers are read-only projections of existing
   *  modules (never mutated from the calendar). */
  async calendar(companyId: string, options: {
    from: Date;
    to: Date;
    layers: string[];
    assignedToId?: string;
    canSeeFinancial: boolean;
    canSeeApprovals: boolean;
  }) {
    const from = options.from;
    const to = options.to;
    const layers: Record<string, unknown[]> = {};
    if (options.layers.includes('activities')) {
      const items = await this.prisma.activity.findMany({
        where: {
          companyId,
          status: { in: ['PENDING', 'COMPLETED'] },
          OR: [
            { dueDate: { gte: from, lte: to } },
            { scheduledDate: { gte: from, lte: to } },
          ],
          ...(options.assignedToId ? { assignedToId: options.assignedToId } : {}),
        },
        include: { type: { select: { code: true, nameFa: true, color: true } }, assignedTo: { select: { id: true, username: true } } },
        orderBy: { dueDate: 'asc' },
        take: 500,
      });
      layers.activities = items.map((a) => this.withDerived(a));
    }
    // financial layers require explicit treasury permission (correction gate)
    if (options.canSeeFinancial && options.layers.includes('checks')) {
      layers.checks = await this.prisma.check.findMany({
        where: { companyId, dueDate: { gte: from, lte: to }, status: { in: ['REGISTERED'] } },
        select: { id: true, checkNumber: true, dueDate: true, amount: true, status: true, direction: true },
        orderBy: { dueDate: 'asc' },
        take: 500,
      });
    }
    if (options.canSeeFinancial && options.layers.includes('payments')) {
      layers.payments = await this.prisma.payment.findMany({
        where: { companyId, paymentDate: { gte: from, lte: to } },
        select: { id: true, paymentNumber: true, paymentDate: true, amount: true, partyId: true },
        orderBy: { paymentDate: 'asc' },
        take: 500,
      });
    }
    // approvals layer: users see their own pending approvals; broad visibility
    // requires the decide permission
    if (options.canSeeApprovals && options.layers.includes('approvals')) {
      layers.approvals = await this.prisma.approvalRequest.findMany({
        where: { companyId, status: 'PENDING', createdAt: { gte: from, lte: to } },
        select: { id: true, entityType: true, entityId: true, approvalType: true, createdAt: true, requestedBy: true },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
    }
    return { layers };
  }
}
