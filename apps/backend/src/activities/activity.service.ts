import { Injectable } from '@nestjs/common';
import { Prisma, ActivityPriority, ActivityStatus } from '@prisma/client';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../parties/timeline.service';
import { AuditService } from '../audit/audit.service';

type Client = Prisma.TransactionClient | PrismaService;

export interface ActivityActor {
  id: string;
  username: string;
}

export interface CreateActivityInput {
  typeCode: string;
  title: string;
  description?: string;
  relatedEntityType: string;
  relatedEntityId: string;
  assignedToId?: string;
  priority?: ActivityPriority;
  scheduledDate?: Date;
  dueDate?: Date;
  /** SYSTEM creator (Workflow/Automation) — no user row is fabricated. */
  actorType?: 'USER' | 'SYSTEM';
  actor?: ActivityActor;
}

export interface UpdateActivityInput {
  title?: string;
  description?: string;
  assignedToId?: string | null;
  priority?: ActivityPriority;
  scheduledDate?: Date | null;
  dueDate?: Date | null;
}

export interface ActivityListFilters {
  assignedToId?: string;
  status?: ActivityStatus;
  priority?: ActivityPriority;
  typeCode?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  dueFrom?: Date;
  dueTo?: Date;
  /** derived bucket: overdue = PENDING && dueDate < now */
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

/** Entities the Activity Engine may attach to (REQUIREMENTS §49). */
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

@Injectable()
export class ActivityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
    private readonly audit: AuditService,
  ) {}

  /** SYSTEM creation (Workflow/Automation §53): idempotent per (company, uid,
   *  relatedEntity) — a repeated automation trigger does not duplicate. */
  async createSystemActivity(companyId: string, input: CreateActivityInput & { idempotencyKey: string }): Promise<{ activityId: string; created: boolean }> {
    const type = await this.resolveType(companyId, input.typeCode);
    if (!ALLOWED_RELATED_TYPES.has(input.relatedEntityType)) {
      throw new ValidationError('ACTIVITY_RELATED_ENTITY_TYPE_INVALID', { relatedEntityType: input.relatedEntityType });
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new ValidationError('ACTIVITY_TITLE_REQUIRED');
    }
    const existing = await this.prisma.activity.findFirst({
      where: {
        companyId,
        typeId: type.id,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
        createdByType: 'SYSTEM',
        title: input.title,
      },
      select: { id: true },
    });
    if (existing) return { activityId: existing.id, created: false };
    const activity = await this.prisma.activity.create({
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
      },
    });
    await this.timeline.record(this.prisma, {
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
    return { activityId: activity.id, created: true };
  }

  async create(companyId: string, input: CreateActivityInput, actor: ActivityActor): Promise<{ id: string }> {
    // user-facing create is STRICT: deactivated or unknown codes are rejected
    // (auto-provisioning is reserved for SYSTEM automation flows)
    const type = await this.resolveType(companyId, input.typeCode);
    if (!ALLOWED_RELATED_TYPES.has(input.relatedEntityType)) {
      throw new ValidationError('ACTIVITY_RELATED_ENTITY_TYPE_INVALID', { relatedEntityType: input.relatedEntityType });
    }
    if (!input.title || input.title.trim().length === 0) {
      throw new ValidationError('ACTIVITY_TITLE_REQUIRED');
    }
    if (input.assignedToId) await this.assertCompanyUser(companyId, input.assignedToId);
    const activity = await this.prisma.activity.create({
      data: {
        companyId,
        typeId: type.id,
        title: input.title.trim(),
        description: input.description,
        relatedEntityType: input.relatedEntityType,
        relatedEntityId: input.relatedEntityId,
        createdByType: input.actorType ?? 'USER',
        createdById: actor.id,
        assignedToId: input.assignedToId ?? null,
        priority: input.priority ?? 'NORMAL',
        scheduledDate: input.scheduledDate ?? null,
        dueDate: input.dueDate ?? null,
      },
    });
    await this.audit.record({
      entityType: 'activity',
      entityId: activity.id,
      action: 'CREATE',
      companyId,
      actor,
      newValues: { title: activity.title, typeCode: input.typeCode, dueDate: input.dueDate ?? null },
    });
    await this.timeline.record(this.prisma, {
      companyId,
      entityType: input.relatedEntityType,
      entityId: input.relatedEntityId,
      type: 'ACTIVITY_CREATED',
      title: `فعالیت: ${activity.title}`,
      description: input.description,
      data: { activityId: activity.id, typeCode: input.typeCode },
      actorUserId: actor.id,
    });
    return { id: activity.id };
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
    const type = await this.prisma.activityType.create({
      data: { companyId, code: input.code.trim(), nameFa: input.nameFa.trim(), color: input.color ?? null },
    });
    await this.audit.record({
      entityType: 'activity_type',
      entityId: type.id,
      action: 'CREATE',
      companyId,
      actor,
      newValues: { code: type.code, nameFa: type.nameFa },
    });
    return type;
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
    if (options.layers.includes('checks')) {
      layers.checks = await this.prisma.check.findMany({
        where: { companyId, dueDate: { gte: from, lte: to }, status: { in: ['REGISTERED'] } },
        select: { id: true, checkNumber: true, dueDate: true, amount: true, status: true, direction: true },
        orderBy: { dueDate: 'asc' },
        take: 500,
      });
    }
    if (options.layers.includes('payments')) {
      layers.payments = await this.prisma.payment.findMany({
        where: { companyId, paymentDate: { gte: from, lte: to } },
        select: { id: true, paymentNumber: true, paymentDate: true, amount: true, partyId: true },
        orderBy: { paymentDate: 'asc' },
        take: 500,
      });
    }
    if (options.layers.includes('approvals')) {
      layers.approvals = await this.prisma.approvalRequest.findMany({
        where: { companyId, status: 'PENDING', createdAt: { gte: from, lte: to } },
        select: { id: true, entityType: true, entityId: true, approvalType: true, createdAt: true, requestedBy: true },
        orderBy: { createdAt: 'asc' },
        take: 500,
      });
    }
    return { layers };
  }

  async getById(companyId: string, id: string) {
    const activity = await this.prisma.activity.findFirst({
      where: { id, companyId },
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
      // derived overdue (REQUIREMENTS §49): PENDING and past due
      ...(filters.overdueOnly ? { status: 'PENDING' as ActivityStatus, dueDate: { lt: now, not: null } } : {}),
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

  /** Update a PENDING activity. Completed activities are LOCKED for normal
   *  users; changing them requires activities.override + a reason and is
   *  audited with the override marker stored on the row. */
  async update(
    companyId: string,
    id: string,
    input: UpdateActivityInput & { overrideReason?: string },
    actor: ActivityActor,
    canOverride: boolean,
  ): Promise<void> {
    const activity = await this.mustGet(companyId, id);
    const isCompleted = activity.status !== 'PENDING';
    if (isCompleted) {
      if (!canOverride) throw new ValidationError('ACTIVITY_LOCKED_OVERRIDE_REQUIRED', { status: activity.status });
      if (!input.overrideReason || input.overrideReason.trim().length < 3) {
        throw new ValidationError('ACTIVITY_OVERRIDE_REASON_REQUIRED');
      }
    }
    if (input.assignedToId) await this.assertCompanyUser(companyId, input.assignedToId);
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
    });
    await this.audit.record({
      entityType: 'activity',
      entityId: id,
      action: isCompleted ? 'OVERRIDE_UPDATE' : 'UPDATE',
      companyId,
      actor,
      oldValues: { title: activity.title, status: activity.status },
      newValues: { ...input },
      reason: isCompleted ? input.overrideReason : undefined,
    });
  }

  /** Complete a PENDING activity (assigned user, any company user with
   *  activities.edit, or manager). Writes the timeline event on the related
   *  entity with a DEDUP guard: one ACTIVITY_COMPLETED event per activity. */
  async complete(companyId: string, id: string, actor: ActivityActor, note?: string): Promise<void> {
    const activity = await this.mustGet(companyId, id);
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
    });
    await this.audit.record({
      entityType: 'activity',
      entityId: id,
      action: 'COMPLETE',
      companyId,
      actor,
      newValues: { completedAt: new Date().toISOString(), note: note ?? null },
    });
  }

  async cancel(companyId: string, id: string, actor: ActivityActor, reason: string): Promise<void> {
    const activity = await this.mustGet(companyId, id);
    if (activity.status !== 'PENDING') {
      throw new ConflictError('ACTIVITY_ALREADY_COMPLETED', { status: activity.status });
    }
    await this.prisma.activity.update({ where: { id }, data: { status: 'CANCELLED' } });
    await this.audit.record({
      entityType: 'activity',
      entityId: id,
      action: 'CANCEL',
      companyId,
      actor,
      reason,
    });
  }

  async delete(companyId: string, id: string, actor: ActivityActor): Promise<void> {
    const activity = await this.mustGet(companyId, id);
    await this.prisma.activity.delete({ where: { id } });
    await this.audit.record({
      entityType: 'activity',
      entityId: id,
      action: 'DELETE',
      companyId,
      actor,
      oldValues: { title: activity.title, status: activity.status },
    });
  }

  private async mustGet(companyId: string, id: string) {
    const activity = await this.prisma.activity.findFirst({
      where: { id, companyId },
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

  /** Activity types are DYNAMIC (REQUIREMENTS §49): referencing an unknown
   *  code auto-provisions it so flows like the calendar can create
   *  activities without a pre-registration step. */
  private async ensureType(companyId: string, code: string) {
    const existing = await this.prisma.activityType.findUnique({
      where: { companyId_code: { companyId, code } },
    });
    if (existing) return existing;
    return this.prisma.activityType.create({
      data: { companyId, code: code.trim(), nameFa: code.trim() },
    });
  }

  private async assertCompanyUser(companyId: string, userId: string): Promise<void> {
    const member = await this.prisma.userCompanyRole.findFirst({
      where: { userId, companyId },
      select: { roleId: true },
    });
    if (!member) throw new ValidationError('ACTIVITY_ASSIGNEE_NOT_IN_COMPANY', { userId });
  }

  /** Derived fields: overdue = PENDING && dueDate < now (computed, not stored). */
  private withDerived<
    T extends { status: ActivityStatus; dueDate: Date | null; priority: ActivityPriority },
  >(activity: T): T & { overdue: boolean } {
    return {
      ...activity,
      overdue: activity.status === 'PENDING' && !!activity.dueDate && activity.dueDate.getTime() < Date.now(),
    };
  }
}
