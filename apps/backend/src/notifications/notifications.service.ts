import { Inject, Injectable } from '@nestjs/common';
import { Notification, NotificationRule, Prisma, QueuePriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { evaluateConditions, RuleConditions } from './notification-conditions';
import { NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { QueueService } from '../queue/queue.service';
import { QueueHandler } from '../queue/queue.handlers';
import { CreateNotificationRuleDto, UpdateNotificationRuleDto } from './notifications.dto';

export type RecipientConfig = {
  type: 'ROLE' | 'USER' | 'RECORD_OWNER';
  value: string;
};

export interface DispatchOptions {
  /** Dispatching company; null = platform-level notification (Mini-Gate). */
  companyId?: string | null;
  title: string;
  body?: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  priority?: QueuePriority;
  recipients: RecipientConfig[];
}

/**
 * Creates IN_APP Notification rows for resolved recipients.
 * Recipient resolution:
 *   ROLE          → users holding that role code inside the company
 *   USER          → the user id directly
 *   RECORD_OWNER  → the record owner (explicit in payload or the config value)
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
  ) {}

  async resolveRecipients(
    companyId: string,
    recipients: RecipientConfig[],
    payload: Record<string, unknown> = {},
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const recipient of recipients) {
      if (recipient.type === 'USER') {
        ids.push(recipient.value);
      } else if (recipient.type === 'RECORD_OWNER') {
        const owner =
          typeof payload.recordOwnerId === 'string'
            ? payload.recordOwnerId
            : recipient.value;
        if (owner) ids.push(owner);
      } else if (recipient.type === 'ROLE') {
        // Mini-Gate: roles are company-scoped — resolve ROLE recipients by
        // their user_company_roles assignment inside THIS company.
        const users = await this.prisma.user.findMany({
          where: {
            status: 'ACTIVE',
            companies: { some: { companyId } },
            companyRoles: { some: { companyId, role: { code: recipient.value } } },
          },
          select: { id: true },
        });
        ids.push(...users.map((u) => u.id));
      }
    }
    return [...new Set(ids)];
  }

  async createNotifications(
    userIds: string[],
    options: Omit<DispatchOptions, 'recipients'>,
  ): Promise<Notification[]> {
    if (userIds.length === 0) return [];
    // Mini-Gate: notifications carry the dispatch context's companyId
    // (null = platform-level notification).
    return this.prisma.$transaction(
      userIds.map((userId) =>
        this.prisma.notification.create({
          data: {
            userId,
            companyId: options.companyId ?? null,
            title: options.title,
            body: options.body,
            relatedEntityType: options.relatedEntityType,
            relatedEntityId: options.relatedEntityId,
            priority: options.priority ?? 'NORMAL',
          },
        }),
      ),
    );
  }

  /**
   * List the current user's notifications, newest first (uses the
   * (userId, companyId, status, createdAt) index). Optional companyId and
   * status filters; pass `includePlatform: true` to also see platform-wide
   * (companyId null) notifications alongside a company filter.
   */
  async listForUser(
    userId: string,
    query: {
      companyId?: string | null;
      status?: Notification['status'];
      includePlatform?: boolean;
      skip: number;
      take: number;
    },
  ): Promise<Paginated<Notification>> {
    const companyScope: Prisma.NotificationWhereInput = query.includePlatform
      ? { OR: [{ companyId: query.companyId ?? null }, { companyId: null }] }
      : { companyId: query.companyId ?? null };
    const where: Prisma.NotificationWhereInput = {
      userId,
      ...companyScope,
      status: query.status,
    };
    const [items, total] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.notification.count({ where }),
    ]);
    return {
      items,
      total,
      page: Math.floor(query.skip / Math.max(query.take, 1)) + 1,
      pageSize: query.take,
    };
  }

  /**
   * Dispatch the enabled, condition-matching rules for `event`. Returns the
   * number of rules that actually dispatched (0 when nothing matched —
   * callers may fall back to a direct notification, e.g. the claim declarer).
   */
  async dispatchRulesForEvent(
    event: string,
    payload: Record<string, unknown>,
    base: Omit<DispatchOptions, 'recipients'>,
  ): Promise<number> {
    // Rules are company-scoped; a platform dispatch (companyId null) matches
    // no rules by design.
    const rules = await this.prisma.notificationRule.findMany({
      where: { companyId: base.companyId ?? undefined, event, enabled: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
    const matching = rules.filter((rule) =>
      evaluateConditions((rule.conditions ?? undefined) as RuleConditions, payload),
    );

    for (const rule of matching) {
      const recipients = (rule.recipientConfig as unknown as RecipientConfig[]) ?? [];
      const delayMinutes = Number(
        (rule.delayConfig as { delayMinutes?: number } | null)?.delayMinutes ?? 0,
      );
      const resolved = await this.resolveRecipients(rule.companyId, recipients, payload);
      // The notification carries the RULE's company (dispatch event context).
      const ruleBase = { ...base, companyId: rule.companyId };
      if (delayMinutes > 0) {
        // Delayed delivery: durable queue job; the handler creates the rows.
        await this.queueService.enqueue({
          jobType: 'notification.dispatch',
          companyId: rule.companyId,
          payload: { userIds: resolved, base: ruleBase },
          delayMs: delayMinutes * 60_000,
        });
      } else {
        await this.createNotifications(resolved, ruleBase);
      }
    }
    return matching.length;
  }
}

/** Queue handler for delayed notifications (type `notification.dispatch`). */
@Injectable()
export class NotificationDispatchHandler implements QueueHandler {
  readonly type = 'notification.dispatch';

  constructor(private readonly notificationService: NotificationService) {}

  async handle(payload: unknown): Promise<void> {
    const { userIds, base } = (payload ?? {}) as {
      userIds: string[];
      base: Omit<DispatchOptions, 'recipients'>;
    };
    if (Array.isArray(userIds) && base) {
      await this.notificationService.createNotifications(userIds, base);
    }
  }
}

/**
 * CRUD for notification rules (REQUIREMENTS §111-115). Rules are company
 * scoped; conditions are evaluated with the pure evaluateConditions helper.
 */
@Injectable()
export class NotificationRuleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string, event?: string): Promise<NotificationRule[]> {
    return this.prisma.notificationRule.findMany({
      where: { companyId, event },
      orderBy: [{ event: 'asc' }, { priority: 'asc' }],
    });
  }

  /** Rules for an event, priority-ordered (enabled first by contract). */
  async rulesForEvent(companyId: string, event: string): Promise<NotificationRule[]> {
    return this.prisma.notificationRule.findMany({
      where: { companyId, event, enabled: true },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async getById(companyId: string, id: string): Promise<NotificationRule> {
    const rule = await this.prisma.notificationRule.findUnique({ where: { id } });
    if (!rule || rule.companyId !== companyId) {
      throw new NotFoundError('Notification rule not found', { id });
    }
    return rule;
  }

  async create(
    companyId: string,
    dto: CreateNotificationRuleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<NotificationRule> {
    const rule = await this.prisma.notificationRule.create({
      data: {
        companyId,
        code: dto.code,
        event: dto.event,
        conditions: dto.conditions as Prisma.InputJsonValue | undefined,
        recipientConfig: dto.recipientConfig as Prisma.InputJsonValue,
        channels: dto.channels as Prisma.InputJsonValue,
        delayConfig: dto.delayConfig as Prisma.InputJsonValue | undefined,
        priority: dto.priority ?? 'NORMAL',
        enabled: dto.enabled ?? true,
      },
    });
    await this.auditService.record({
      entityType: 'notification_rule',
      entityId: rule.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { code: rule.code, event: rule.event },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return rule;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateNotificationRuleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<NotificationRule> {
    const existing = await this.getById(companyId, id);
    const rule = await this.prisma.notificationRule.update({
      where: { id: existing.id },
      data: {
        event: dto.event,
        conditions: dto.conditions as Prisma.InputJsonValue | undefined,
        recipientConfig: dto.recipientConfig as Prisma.InputJsonValue | undefined,
        channels: dto.channels as Prisma.InputJsonValue | undefined,
        delayConfig: dto.delayConfig as Prisma.InputJsonValue | undefined,
        priority: dto.priority,
        enabled: dto.enabled,
      },
    });
    await this.auditService.record({
      entityType: 'notification_rule',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: { code: existing.code, event: existing.event, enabled: existing.enabled },
      newValues: { code: rule.code, event: rule.event, enabled: rule.enabled },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return rule;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    await this.prisma.notificationRule.delete({ where: { id: existing.id } });
    await this.auditService.record({
      entityType: 'notification_rule',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      companyId,
      oldValues: { code: existing.code, event: existing.event },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
