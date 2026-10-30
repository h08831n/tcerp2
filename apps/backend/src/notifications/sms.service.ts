import { Injectable, Logger } from '@nestjs/common';
import {
  NotificationRule,
  Prisma,
  SmsMessage,
  SmsMessageSource,
  SmsMessageStatus,
  SmsTemplate,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { QueueService } from '../queue/queue.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { normalizeIranMobile } from '../common/utils/phone';
import {
  CreateSmsTemplateDto,
  SmsMessageQueryDto,
  UpdateSmsTemplateDto,
} from './notifications.dto';

/** Simple {key} interpolation from the event payload (same as automation). */
export function interpolateSmsVars(text: string, vars: Record<string, unknown>): string {
  return String(text ?? '').replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Notification-rule SMS channel policy (REQUIREMENTS §27, Phase 9D). */
export interface RuleSmsConfig {
  /** Send via this SmsTemplate (code) instead of a literal text. */
  templateCode?: string;
  /** Literal text (interpolated) when no templateCode. */
  text?: string;
  /** Extra explicit party ids to text (in addition to the event's party). */
  partyIds?: string[];
  /** Text the event's partyId too (default true). */
  usePayloadParty?: boolean;
  /** Vars merged under the payload for interpolation. */
  vars?: Record<string, unknown>;
}

export interface EnqueueSmsInput {
  to: string;
  text: string;
  source: SmsMessageSource;
  sourceId?: string;
  templateCode?: string;
  partyId?: string;
  idempotencyKey: string;
  requestedById?: string;
  delayMs?: number;
}

/**
 * SMS center (Phase 9D, REQUIREMENTS §27 SMS): every outbound SMS is a
 * durable `SmsMessage` row created AT ENQUEUE time (QUEUED) and flipped by
 * the `sms.send` handler (SENT / FAILED + provider response) — the send
 * report IS the log; resend = a fresh row. Idempotency is a DB guarantee:
 * the unique idempotencyKey reconciles concurrent duplicates (P2002 → the
 * existing row, never a second message or a second queue job).
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger('SmsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly auditService: AuditService,
  ) {}
  async render(
    companyId: string,
    input: { templateCode?: string; text?: string },
    vars: Record<string, unknown>,
  ): Promise<{ text: string; templateCode: string | null }> {
    if (input.templateCode) {
      const template = await this.prisma.smsTemplate.findFirst({
        where: { companyId, code: input.templateCode, isActive: true },
      });
      if (!template) {
        throw new NotFoundError('SMS template not found', { templateCode: input.templateCode });
      }
      return {
        text: interpolateSmsVars(template.bodyTemplate, vars),
        templateCode: template.code,
      };
    }
    if (typeof input.text === 'string' && input.text.trim().length > 0) {
      return { text: interpolateSmsVars(input.text, vars), templateCode: null };
    }
    throw new ValidationError('SMS_TEXT_REQUIRED');
  }

  /**
   * Queue one SMS: validate + canonicalize the mobile, persist the QUEUED
   * log row (deduped by idempotencyKey), then enqueue ONE `sms.send` delivery
   * carrying the message id (queue-level retry ≤3 updates the same row).
   */
  async enqueueSend(
    companyId: string,
    input: EnqueueSmsInput,
  ): Promise<{ message: SmsMessage; created: boolean }> {
    const to = normalizeIranMobile(input.to);
    if (!input.text || input.text.trim().length === 0) {
      throw new ValidationError('SMS_TEXT_REQUIRED');
    }
    let message: SmsMessage;
    let created = true;
    try {
      message = await this.prisma.smsMessage.create({
        data: {
          companyId,
          to,
          text: input.text,
          status: SmsMessageStatus.QUEUED,
          source: input.source,
          sourceId: input.sourceId,
          templateCode: input.templateCode,
          partyId: input.partyId,
          idempotencyKey: input.idempotencyKey,
          requestedById: input.requestedById,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Duplicate request — the existing row IS the authority (no second
        // queue job; a racing enqueue reconciles to the same message).
        const existing = await this.prisma.smsMessage.findUniqueOrThrow({
          where: { idempotencyKey: input.idempotencyKey },
        });
        return { message: existing, created: false };
      }
      throw error;
    }
    const job = await this.queueService.enqueue({
      jobType: 'sms.send',
      companyId,
      payload: { smsMessageId: message.id },
      idempotencyKey: `sms-job:${message.id}`,
      maxAttempts: 3,
      priority: 'HIGH',
      delayMs: Math.max(0, input.delayMs ?? 0),
    });
    message = await this.prisma.smsMessage.update({
      where: { id: message.id },
      data: { queuedJobId: job.id },
    });
    return { message, created };
  }

  /**
   * SMS channel of a notification rule (Phase 9D): resolve the target
   * parties (event partyId + explicit smsConfig.partyIds), take each
   * party's best MOBILE phone, render template/literal text against the
   * payload and enqueue one deduped message per mobile. The rule's delay
   * rides on the sms.send delivery. Recipients without a mobile are
   * silently skipped (they count in the returned counters).
   */
  async dispatchForRule(
    rule: NotificationRule,
    event: string,
    payload: Record<string, unknown>,
    delayMinutes: number,
  ): Promise<{ targeted: number; sent: number; skippedNoMobile: number }> {
    const config = (rule.smsConfig ?? {}) as RuleSmsConfig;
    const partyIds = new Set<string>();
    if (config.usePayloadParty !== false && typeof payload.partyId === 'string' && payload.partyId) {
      partyIds.add(payload.partyId);
    }
    for (const id of Array.isArray(config.partyIds) ? config.partyIds : []) {
      if (typeof id === 'string' && id) partyIds.add(id);
    }
    if (partyIds.size === 0) return { targeted: 0, sent: 0, skippedNoMobile: 0 };

    const parties = await this.prisma.party.findMany({
      where: { companyId: rule.companyId, id: { in: [...partyIds] }, archivedAt: null },
      select: { id: true, phones: { where: { kind: 'MOBILE' }, select: { normalizedValue: true }, take: 1 } },
    });

    const rendered = await this.render(
      rule.companyId,
      { templateCode: config.templateCode, text: config.text },
      { ...payload, ...(config.vars ?? {}) },
    );

    const eventKey = typeof payload.eventKey === 'string' && payload.eventKey
      ? payload.eventKey
      : String(payload.date ?? '');
    let sent = 0;
    let skippedNoMobile = 0;
    for (const party of parties) {
      const mobile = party.phones[0]?.normalizedValue;
      if (!mobile) {
        skippedNoMobile += 1;
        continue;
      }
      const { created } = await this.enqueueSend(rule.companyId, {
        to: mobile,
        text: rendered.text,
        source: SmsMessageSource.NOTIFICATION_RULE,
        sourceId: rule.id,
        templateCode: rendered.templateCode ?? undefined,
        partyId: party.id,
        // Dedup: one message per (rule, party, event occurrence) — a
        // redelivered or replayed event reconciles to the SAME row.
        idempotencyKey: `notification-sms:${rule.id}:${party.id}:${eventKey}`,
        delayMs: delayMinutes * 60_000,
      });
      if (created) sent += 1;
    }
    return { targeted: parties.length, sent, skippedNoMobile };
  }

  /** The send report (REQUIREMENTS §27 «گزارش ارسال») — the log itself. */
  async list(companyId: string, query: SmsMessageQueryDto): Promise<Paginated<SmsMessage>> {
    const where: Prisma.SmsMessageWhereInput = {
      companyId,
      status: query.status,
      source: query.source,
    };
    const [items, total] = await Promise.all([
      this.prisma.smsMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.smsMessage.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getMessage(companyId: string, id: string): Promise<SmsMessage> {
    const message = await this.prisma.smsMessage.findUnique({ where: { id } });
    if (!message || message.companyId !== companyId) {
      throw new NotFoundError('SMS message not found', { id });
    }
    return message;
  }

  /**
   * Resend a FAILED message: a fresh row (the original log is history, never
   * rewritten) with a deterministic resend idempotency key — two concurrent
   * resends reconcile to ONE new message via the unique constraint.
   */
  async resend(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<SmsMessage> {
    const original = await this.getMessage(companyId, id);
    if (original.status !== SmsMessageStatus.FAILED) {
      throw new ConflictError('SMS_RESEND_ONLY_FAILED', { status: original.status });
    }
    const previousResends = await this.prisma.smsMessage.count({
      where: { companyId, idempotencyKey: { startsWith: `sms-resend:${original.id}:` } },
    });
    const { message } = await this.enqueueSend(companyId, {
      to: original.to,
      text: original.text,
      source: SmsMessageSource.MANUAL,
      sourceId: original.id,
      templateCode: original.templateCode ?? undefined,
      partyId: original.partyId ?? undefined,
      requestedById: actor.id,
      idempotencyKey: `sms-resend:${original.id}:${previousResends + 1}`,
    });
    await this.auditLog(companyId, message.id, actor, ctx, original.id);
    return message;
  }

  private async auditLog(
    companyId: string,
    messageId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
    originalId?: string,
  ): Promise<void> {
    await this.auditService.record({
      entityType: 'sms_message',
      entityId: messageId,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { resendOf: originalId ?? null },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}

/** SMS templates: company-scoped, {var} placeholders, activate/deactivate. */
@Injectable()
export class SmsTemplateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string): Promise<SmsTemplate[]> {
    return this.prisma.smsTemplate.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
  }

  async getById(companyId: string, id: string): Promise<SmsTemplate> {
    const template = await this.prisma.smsTemplate.findUnique({ where: { id } });
    if (!template || template.companyId !== companyId) {
      throw new NotFoundError('SMS template not found', { id });
    }
    return template;
  }

  async create(
    companyId: string,
    dto: CreateSmsTemplateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<SmsTemplate> {
    const template = await this.prisma.smsTemplate.create({
      data: {
        companyId,
        code: dto.code,
        nameFa: dto.nameFa,
        bodyTemplate: dto.bodyTemplate,
        isActive: dto.isActive ?? true,
      },
    });
    await this.auditService.record({
      entityType: 'sms_template',
      entityId: template.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { code: template.code },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return template;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateSmsTemplateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<SmsTemplate> {
    const existing = await this.getById(companyId, id);
    const template = await this.prisma.smsTemplate.update({
      where: { id: existing.id },
      data: {
        nameFa: dto.nameFa,
        bodyTemplate: dto.bodyTemplate,
        isActive: dto.isActive,
      },
    });
    await this.auditService.record({
      entityType: 'sms_template',
      entityId: id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: { nameFa: existing.nameFa, isActive: existing.isActive },
      newValues: { nameFa: template.nameFa, isActive: template.isActive },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return template;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getById(companyId, id);
    await this.prisma.smsTemplate.delete({ where: { id: existing.id } });
    await this.auditService.record({
      entityType: 'sms_template',
      entityId: id,
      action: AuditAction.DELETE,
      companyId,
      actor,
      oldValues: { code: existing.code },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}

/** Result carrier for the sms.send handler. */
export interface SmsSendOutcome {
  ok: boolean;
  error?: string;
  providerResponse?: unknown;
}

/** Flip a QUEUED message to SENT/FAILED (the queue handler's write-back). */
export async function settleSmsMessage(
  prisma: PrismaService,
  messageId: string,
  outcome: SmsSendOutcome,
): Promise<SmsMessage | null> {
  return prisma.smsMessage.update({
    where: { id: messageId },
    data: {
      status: outcome.ok ? SmsMessageStatus.SENT : SmsMessageStatus.FAILED,
      sentAt: outcome.ok ? new Date() : null,
      error: outcome.ok ? null : (outcome.error ?? 'SMS_PROVIDER_FAILED'),
      providerResponse: (outcome.providerResponse ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}
