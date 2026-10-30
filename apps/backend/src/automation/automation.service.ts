import { Injectable, Logger } from '@nestjs/common';
import { AutomationRule, AutomationRun, Prisma, PublishChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ValidationError } from '../common/errors';
import { QueueService } from '../queue/queue.service';
import { PublishingService } from '../publishing/publishing.service';
import {
  evaluateConditions,
  RuleConditions,
} from '../notifications/notification-conditions';
import {
  NotificationService,
  RecipientConfig,
} from '../notifications/notifications.service';
import { PriceUpdatedHook } from '../pricing/daily-price.service';
import { dayKeyOf, parseDayKey, todayKey } from '../pricing/day';
import { ActivityService } from '../activities/activity.service';

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/** Simple {key} interpolation from the event payload. */
function interpolate(text: string, event: Record<string, unknown>): string {
  return String(text ?? '').replace(/\{(\w+)\}/g, (_m, key: string) => {
    const value = event[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

export interface ScanRuleSummary {
  ruleId: string;
  code: string;
  triggerType: string;
  candidates: number;
  executed: number;
  skippedDuplicates: number;
  conditionSkipped: number;
}

/** Per-rule execution policy (Phase 9C): delay before first run + bounded retries. */
export interface AutomationExecutionPolicy {
  /** Wait N minutes after a matched event before executing the action. */
  delayMinutes: number;
  /** Total execution attempts (first + retries). Default 3, max 10. */
  maxAttempts: number;
  /** Minutes between retries. Default 5. */
  retryDelayMinutes: number;
}

const DEFAULT_POLICY: AutomationExecutionPolicy = {
  delayMinutes: 0,
  maxAttempts: 3,
  retryDelayMinutes: 5,
};

/** Read the execution policy off a rule's triggerConfig (delay) and actionConfig (retry). */
export function executionPolicyOf(rule: {
  triggerConfig?: unknown;
  actionConfig?: unknown;
}): AutomationExecutionPolicy {
  const trigger = (rule.triggerConfig ?? {}) as { delayMinutes?: unknown };
  const action = (rule.actionConfig ?? {}) as {
    retry?: { maxAttempts?: unknown; delayMinutes?: unknown };
  };
  const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
  };
  return {
    delayMinutes: clampInt(trigger.delayMinutes, 0, 60 * 24 * 7, DEFAULT_POLICY.delayMinutes),
    maxAttempts: clampInt(action.retry?.maxAttempts, 1, 10, DEFAULT_POLICY.maxAttempts),
    retryDelayMinutes: clampInt(action.retry?.delayMinutes, 1, 60 * 24, DEFAULT_POLICY.retryDelayMinutes),
  };
}

// ───────────────────── SEND_SMS audience (p5c extension point) ─────────────────────

/** Max sms.send jobs ONE audience run enqueues — protects the daily scan. */
export const SMS_AUDIENCE_CAP = 200;

export type SmsAudienceType = 'ALL_CUSTOMERS' | 'INACTIVE_DAYS' | 'PRODUCT_BUYERS';

/**
 * SEND_SMS `actionConfig.audience` (p5c pricing-integrity review): when set,
 * the action targets a RESOLVED CUSTOMER AUDIENCE instead of the single
 * record's mobile. This is the clean extension point for future
 * favorite-products / behavior-driven rules (AI later): new audience types
 * slot into `resolveAudience` and every caller (daily scan, manual run,
 * future rule UI) keeps working unchanged.
 */
export interface SmsAudienceConfig {
  type: SmsAudienceType;
  /** INACTIVE_DAYS: last sales_document older than N days (default 60). */
  days?: number;
  /** PRODUCT_BUYERS: distinct customers with a sales line on this variant. */
  productVariantId?: string;
}

/** One resolved audience member (party + best mobile for the sms.send job). */
export interface SmsAudienceMember {
  partyId: string;
  nameFa: string;
  mobile: string | null;
  ownerUserId: string | null;
  /** YYYY-MM-DD of the last (non-cancelled) sale — null when never purchased. */
  lastPurchaseDate: string | null;
}

function hasAudience(rule: AutomationRule): boolean {
  const config = (rule.actionConfig ?? {}) as { audience?: SmsAudienceConfig };
  return typeof config.audience?.type === 'string' && config.audience.type.length > 0;
}

/**
 * Automation runner (Phase 5 lean subset of REQUIREMENTS §52):
 *   - PRICE_UPDATED: fired by the pricing engine AFTER the price write
 *     commits. Conditions reuse the notification-condition evaluator. The
 *     action runs ASYNC via the `automation.run` queue job so the user's
 *     price upsert never blocks. Duplicate events are deduped by the run
 *     idempotencyKey `auto:{ruleId}:{variantId}:{date}` — the loser becomes
 *     a SKIPPED run row (never a double publish).
 *   - CUSTOMER_INACTIVE_DAYS / QUOTATION_PENDING_DAYS: daily scans executed
 *     by the `automation.daily_scan` queue job (06:00, self-rescheduling) or
 *     the manual run endpoint. Per-record run keys
 *     `daily:{ruleId}:{date}:{partyId|documentId}` make re-runs no-ops.
 *     p5c: a SEND_SMS rule with `actionConfig.audience` instead runs ONCE
 *     per date (`daily:{ruleId}:{date}:audience`) and fans out one capped
 *     sms.send per resolved customer — the extension point for future
 *     favorite-products / behavior rules (see resolveAudience + README).
 *
 * Note on purchase activity: CUSTOMER_INACTIVE_DAYS derives the last purchase
 * from sales_documents (max documentDate per party, CANCELLED excluded).
 * When the operational-data phase lands, the same scan can switch to the
 * operational ledger without changing the run/idempotency contract.
 */
@Injectable()
export class AutomationService implements PriceUpdatedHook {
  private readonly logger = new Logger('AutomationService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly queueService: QueueService,
    private readonly publishingService: PublishingService,
    private readonly notificationService: NotificationService,
    private readonly activityService: ActivityService,
  ) {}

  // ───────────────────── PRICE_UPDATED trigger ─────────────────────

  async handlePriceUpdated(
    companyId: string,
    event: {
      variantId: string;
      variantSku: string;
      categoryId: string | null;
      brandId: string | null;
      uomId: string;
      price: string;
      previousPrice: string | null;
      priceChanged: boolean;
      date: string;
      source: string;
    },
  ): Promise<void> {
    const rules = await this.prisma.automationRule.findMany({
      where: { companyId, triggerType: 'PRICE_UPDATED', enabled: true },
    });
    for (const rule of rules) {
      const key = `auto:${rule.id}:${event.variantId}:${event.date}`;
      const matched = this.evaluateRule(rule, event as unknown as Record<string, unknown>);
      const run = await this.tryCreateRun(rule, key, event, matched);
      if (run.status === 'SKIPPED') continue; // duplicate event — no double publish
      if (!matched) continue; // run row already records conditionsResult.matched=false
      const policy = executionPolicyOf(rule);
      await this.queueService.enqueue({
        jobType: 'automation.run',
        companyId,
        payload: { runId: run.id },
        idempotencyKey: key,
        priority: 'HIGH',
        // ONE delivery per event — retries are owned by the DURABLE run row
        // (attempts counter + bounded policy), not by queue redelivery.
        maxAttempts: 1,
        delayMs: policy.delayMinutes * 60_000,
      });
    }
  }

  // ───────────────────── run execution (queue + inline) ─────────────────────

  /** Execute a PENDING run row (async via `automation.run` or inline scans). */
  async executeRun(runId: string): Promise<AutomationRun | null> {
    const run = await this.prisma.automationRun.findUnique({
      where: { id: runId },
      include: { rule: true },
    });
    if (!run || run.status !== 'PENDING') return run ?? null; // idempotent re-run

    // Count EVERY execution attempt (success or failure) — attempts is the
    // observable retry budget on the run row.
    await this.prisma.automationRun.update({
      where: { id: run.id },
      data: { attempts: { increment: 1 } },
    });

    const rule = run.rule;
    const companyId = rule.companyId;
    const event = (run.triggerPayload ?? {}) as Record<string, unknown>;
    try {
      let result: Record<string, unknown>;
      switch (rule.actionType) {
        case 'PUBLISH_PRICE':
          result = await this.actionPublishPrice(rule, companyId, event);
          break;
        case 'CREATE_NOTIFICATION':
          result = await this.actionCreateNotification(rule, companyId, event, run.id);
          break;
        case 'CREATE_ACTIVITY':
          // Phase 9C: the Activity engine exists (Phase 9A) — the action now
          // creates a REAL system activity (idempotent via the run's
          // idempotency key), falling back to a tagged notification only when
          // the event carries no workflow-compatible related entity.
          result = await this.actionCreateActivity(rule, companyId, event, run);
          break;
        case 'SEND_SMS':
          result = await this.actionSendSms(rule, companyId, event, run);
          break;
      }
      return await this.prisma.automationRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          finishedAt: new Date(),
          conditionsResult: toJson({
            matched: true,
            action: rule.actionType,
            result,
          }),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Automation run ${run.id} failed: ${message}`);
      const fresh = await this.prisma.automationRun.findUniqueOrThrow({
        where: { id: run.id },
        select: { attempts: true },
      });
      const attempts = fresh.attempts;
      const policy = executionPolicyOf(rule);
      if (attempts < policy.maxAttempts) {
        // Bounded DURABLE retry: the run row resets to PENDING and a follow-up
        // queue job re-executes it after the retry delay. The attempts counter
        // (persisted before scheduling) makes the budget crash-safe — a redelivered
        // or repeated failure keeps counting the SAME row, never respawning.
        await this.prisma.automationRun.update({
          where: { id: run.id },
          data: { attempts, status: 'PENDING', error: message, finishedAt: null },
        });
        await this.queueService.enqueue({
          jobType: 'automation.run',
          companyId,
          payload: { runId: run.id },
          idempotencyKey: `automation-retry:${run.id}:${attempts}`,
          maxAttempts: 1,
          delayMs: policy.retryDelayMinutes * 60_000,
        }).catch((enqueueError) =>
          this.logger.error(`Retry enqueue failed for run ${run.id}: ${String(enqueueError)}`),
        );
        return this.prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
      }
      return await this.prisma.automationRun.update({
        where: { id: run.id },
        data: { attempts, status: 'FAILED', finishedAt: new Date(), error: message },
      });
    }
  }

  private async actionPublishPrice(
    rule: AutomationRule,
    companyId: string,
    event: Record<string, unknown>,
  ) {
    const actionConfig = (rule.actionConfig ?? {}) as { channels?: PublishChannel[] };
    const triggerConfig = (rule.triggerConfig ?? {}) as { channels?: PublishChannel[] };
    const channels = actionConfig.channels?.length
      ? actionConfig.channels
      : triggerConfig.channels?.length
        ? triggerConfig.channels
        : ['WEBSITE' as PublishChannel];
    const variantId = String(event.variantId ?? '');
    const priceDate = String(event.date ?? todayKey());
    if (!variantId) throw new NotFoundError('Automation event has no variantId');
    const batch = await this.publishingService.createAutoBatch(companyId, {
      priceDate,
      channels,
      variantIds: [variantId],
      automationRunId: `run:${rule.id}:${priceDate}`,
    });
    return {
      batchId: batch.batch.id,
      batchNumber: batch.batch.batchNumber,
      items: batch.items.length,
      skippedDuplicates: batch.skippedDuplicates.length,
    };
  }

  private async actionCreateNotification(
    rule: AutomationRule,
    companyId: string,
    event: Record<string, unknown>,
    runId: string,
    asActivity = false,
  ) {
    const actionConfig = (rule.actionConfig ?? {}) as {
      title?: string;
      body?: string;
      recipients?: RecipientConfig[];
    };
    const recipients = actionConfig.recipients?.length
      ? actionConfig.recipients
      : [{ type: 'RECORD_OWNER' as const, value: '' }];
    const userIds = await this.notificationService.resolveRecipients(companyId, recipients, event);
    const title = interpolate(actionConfig.title ?? rule.nameFa, event);
    const body = interpolate(actionConfig.body ?? '', event);
    const notifications = await this.notificationService.createNotifications(userIds, {
      companyId,
      title,
      body: body || undefined,
      relatedEntityType: asActivity ? 'automation_activity' : 'automation_run',
      relatedEntityId: runId,
    });
    return { notifications: notifications.length, userIds };
  }

  /**
   * CREATE_ACTIVITY (Phase 9C): a REAL Activity row via the 9A engine's
   * SYSTEM creation — idempotent per run (`activity:{run.idempotencyKey}`),
   * so a retried run never duplicates the follow-up. The related entity is
   * derived from the event payload (partyId/documentId/variantId); events
   * without one degrade to a standalone reminder activity. A failed activity
   * creation propagates (run FAILED → bounded retry), never silently lost.
   */
  private async actionCreateActivity(
    rule: AutomationRule,
    companyId: string,
    event: Record<string, unknown>,
    run: AutomationRun,
  ) {
    const actionConfig = (rule.actionConfig ?? {}) as {
      title?: string;
      description?: string;
      typeCode?: string;
      days?: number;
      assignedToOwner?: boolean;
    };
    const related = this.relatedEntityOf(event);
    if (!related) {
      // An activity must attach to a real business entity — price events and
      // bare manual runs carry none; use CREATE_NOTIFICATION there instead.
      throw new ValidationError('AUTOMATION_ACTIVITY_NO_RELATED_ENTITY', {
        hint: 'CREATE_ACTIVITY rules need a party/document event (daily scans).',
      });
    }
    const dueDate = actionConfig.days
      ? new Date(Date.now() + actionConfig.days * 24 * 60 * 60 * 1000)
      : undefined;
    const outcome = await this.activityService.createSystemActivity(companyId, {
      typeCode: actionConfig.typeCode ?? 'FOLLOW_UP',
      title: interpolate(actionConfig.title ?? rule.nameFa, event),
      description: actionConfig.description ? interpolate(actionConfig.description, event) : undefined,
      relatedEntityType: related.entityType,
      relatedEntityId: related.entityId,
      assignedToId: actionConfig.assignedToOwner === false ? undefined : this.ownerOf(event),
      dueDate,
      idempotencyKey: `activity:${run.idempotencyKey ?? run.id}`,
    });
    return { activityId: outcome.activityId, created: outcome.created, related };
  }

  /** (entityType, entityId) + owner carried by the scan/event payloads. */
  private relatedEntityOf(event: Record<string, unknown>): { entityType: string; entityId: string } | null {
    if (typeof event.partyId === 'string' && event.partyId) return { entityType: 'party', entityId: event.partyId };
    if (typeof event.documentId === 'string' && event.documentId) return { entityType: 'sales_document', entityId: event.documentId };
    return null;
  }

  private ownerOf(event: Record<string, unknown>): string | undefined {
    return typeof event.recordOwnerId === 'string' && event.recordOwnerId ? event.recordOwnerId : undefined;
  }

  // ───────────────────── SEND_SMS audience resolution (p5c) ─────────────────────

  /**
   * Resolve a SEND_SMS audience to customers (p5c — see SmsAudienceConfig).
   * Members without a MOBILE phone are returned with mobile=null; the action
   * skips them (they surface in the run result counters).
   */
  async resolveAudience(companyId: string, audience: SmsAudienceConfig): Promise<SmsAudienceMember[]> {
    if (!audience || !audience.type) throw new ValidationError('AUDIENCE_TYPE_REQUIRED');

    const customers = await this.prisma.party.findMany({
      where: { companyId, archivedAt: null, roles: { some: { role: 'CUSTOMER' } } },
      select: {
        id: true,
        nameFa: true,
        ownerUserId: true,
        phones: { where: { kind: 'MOBILE' }, select: { normalizedValue: true }, take: 1 },
      },
    });

    if (audience.type === 'INACTIVE_DAYS') {
      const days = Number(audience.days ?? 60);
      if (!Number.isFinite(days) || days <= 0) {
        throw new ValidationError('AUDIENCE_DAYS_REQUIRED', { days: audience.days });
      }
      const cutoff = new Date(parseDayKey(todayKey()).getTime() - days * 24 * 60 * 60 * 1000);
      // Last purchase per party from sales_documents (CANCELLED excluded) —
      // customers with NO sale at all count as inactive (matches the
      // CUSTOMER_INACTIVE_DAYS scan semantics).
      const lastSales = await this.prisma.salesDocument.groupBy({
        by: ['customerPartyId'],
        where: { companyId, status: { not: 'CANCELLED' } },
        _max: { documentDate: true },
      });
      const lastByParty = new Map(
        lastSales
          .filter((row) => row._max.documentDate !== null)
          .map((row) => [row.customerPartyId, row._max.documentDate as Date]),
      );
      return customers
        .filter((customer) => {
          const last = lastByParty.get(customer.id);
          return !last || last.getTime() < cutoff.getTime();
        })
        .map((customer) => this.toAudienceMember(customer, lastByParty.get(customer.id) ?? null));
    }

    if (audience.type === 'PRODUCT_BUYERS') {
      if (!audience.productVariantId) {
        throw new ValidationError('AUDIENCE_VARIANT_REQUIRED');
      }
      const buyers = await this.prisma.salesDocument.findMany({
        where: {
          companyId,
          status: { not: 'CANCELLED' },
          lines: { some: { productVariantId: audience.productVariantId } },
        },
        select: { customerPartyId: true },
        distinct: ['customerPartyId'],
      });
      const buyerIds = new Set(buyers.map((buyer) => buyer.customerPartyId));
      return customers
        .filter((customer) => buyerIds.has(customer.id))
        .map((customer) => this.toAudienceMember(customer, null));
    }

    // ALL_CUSTOMERS
    return customers.map((customer) => this.toAudienceMember(customer, null));
  }

  private toAudienceMember(
    customer: {
      id: string;
      nameFa: string;
      ownerUserId: string | null;
      phones: { normalizedValue: string }[];
    },
    lastSale: Date | null,
  ): SmsAudienceMember {
    return {
      partyId: customer.id,
      nameFa: customer.nameFa,
      mobile: customer.phones[0]?.normalizedValue ?? null,
      ownerUserId: customer.ownerUserId ?? null,
      lastPurchaseDate: lastSale ? lastSale.toISOString().slice(0, 10) : null,
    };
  }

  private async actionSendSms(
    rule: AutomationRule,
    companyId: string,
    event: Record<string, unknown>,
    run: AutomationRun,
  ) {
    const actionConfig = (rule.actionConfig ?? {}) as { text?: string; audience?: SmsAudienceConfig };
    const audience = actionConfig.audience;

    if (hasAudience(rule)) {
      // p5c audience mode: one run fans out one sms.send per resolved member
      // (capped). The scan passes the resolved members through the run's
      // trigger payload so the count is logged ON the run row.
      const resolved = Array.isArray(event.audienceMembers)
        ? (event.audienceMembers as SmsAudienceMember[])
        : await this.resolveAudience(companyId, audience as SmsAudienceConfig);
      const members = resolved.slice(0, SMS_AUDIENCE_CAP);
      const keyBase = run.idempotencyKey ?? run.id;
      let queued = 0;
      let skippedNoMobile = 0;
      const seenParties = new Set<string>();
      for (const member of members) {
        // Audience SQL may return one row per qualifying sales document —
        // dedupe by party so one member gets exactly one sms job.
        if (seenParties.has(member.partyId)) continue;
        seenParties.add(member.partyId);
        if (!member.mobile) {
          skippedNoMobile += 1;
          continue;
        }
        const memberEvent: Record<string, unknown> = {
          ...event,
          partyId: member.partyId,
          partyName: member.nameFa,
          mobile: member.mobile,
          recordOwnerId: member.ownerUserId ?? '',
        };
        delete memberEvent.audienceMembers;
        await this.queueService.enqueue({
          jobType: 'sms.send',
          companyId,
          payload: { companyId, to: member.mobile, text: interpolate(actionConfig.text ?? rule.nameFa, memberEvent) },
          idempotencyKey: `sms:${keyBase}:${member.partyId}`,
          priority: 'HIGH',
        });
        queued += 1;
      }
      return {
        queued: true,
        audienceType: audience?.type,
        audienceResolved: resolved.length,
        smsQueued: queued,
        skippedNoMobile,
        cap: SMS_AUDIENCE_CAP,
      };
    }

    const to = String(event.mobile ?? '') || null;
    if (!to) return { queued: false, reason: 'NO_MOBILE' };
    const text = interpolate(actionConfig.text ?? rule.nameFa, event);
    await this.queueService.enqueue({
      jobType: 'sms.send',
      companyId,
      payload: { companyId, to, text },
      idempotencyKey: `sms:${run.idempotencyKey ?? run.id}`,
      priority: 'HIGH',
    });
    return { queued: true, to };
  }

  // ───────────────────── daily scans ─────────────────────

  /**
   * Run all enabled daily-scan rules (optionally scoped to one company/rule).
   * Returns a per-rule summary. Called by the `automation.daily_scan` queue
   * handler and the manual run endpoint.
   */
  async dailyScan(
    input: { companyId?: string; date?: string; ruleId?: string } = {},
  ): Promise<ScanRuleSummary[]> {
    const dateKey = input.date ?? todayKey();
    parseDayKey(dateKey); // validate early

    const ruleWhere: Prisma.AutomationRuleWhereInput = {
      enabled: true,
      triggerType: { in: ['CUSTOMER_INACTIVE_DAYS', 'QUOTATION_PENDING_DAYS'] },
      ...(input.ruleId ? { id: input.ruleId } : {}),
      ...(input.companyId ? { companyId: input.companyId } : {}),
    };
    const rules = await this.prisma.automationRule.findMany({ where: ruleWhere });

    const summaries: ScanRuleSummary[] = [];
    for (const rule of rules) {
      const summary =
        rule.actionType === 'SEND_SMS' && hasAudience(rule)
          ? await this.scanSmsAudience(rule, dateKey)
          : rule.triggerType === 'CUSTOMER_INACTIVE_DAYS'
            ? await this.scanInactiveCustomers(rule, dateKey)
            : await this.scanPendingQuotations(rule, dateKey);
      summaries.push(summary);
    }
    return summaries;
  }

  /**
   * p5c: a SEND_SMS rule with an `actionConfig.audience` runs ONCE per scan
   * date (idempotencyKey `daily:{ruleId}:{date}:audience`) instead of once
   * per record — the resolved audience members travel in the run's trigger
   * payload and the action fans out ONE capped sms.send job per member
   * (`sms:{runKey}:{partyId}`), so re-runs of the same date are no-ops.
   * conditionConfig (when present) evaluates against the audience summary
   * event {date, audienceType, audienceCount}.
   */
  private async scanSmsAudience(rule: AutomationRule, dateKey: string): Promise<ScanRuleSummary> {
    const audience = ((rule.actionConfig ?? {}) as { audience?: SmsAudienceConfig }).audience;
    if (!audience) throw new ValidationError('AUDIENCE_TYPE_REQUIRED');
    const members = await this.resolveAudience(rule.companyId, audience);
    const summary: ScanRuleSummary = {
      ruleId: rule.id,
      code: rule.code,
      triggerType: rule.triggerType,
      candidates: members.length,
      executed: 0,
      skippedDuplicates: 0,
      conditionSkipped: 0,
    };
    const event = {
      date: dateKey,
      scanType: 'SMS_AUDIENCE',
      audienceType: audience.type,
      audienceCount: members.length,
      audienceMembers: members,
    };
    const outcome = await this.runRuleInline(rule, event, `daily:${rule.id}:${dateKey}:audience`);
    if (outcome === 'executed') summary.executed = 1;
    else if (outcome === 'duplicate') summary.skippedDuplicates = 1;
    else summary.conditionSkipped = 1;
    return summary;
  }

  private async scanInactiveCustomers(rule: AutomationRule, dateKey: string): Promise<ScanRuleSummary> {
    const companyId = rule.companyId;
    const days = Number((rule.triggerConfig as { days?: number }).days ?? 60);
    const day = parseDayKey(dateKey);
    const cutoff = new Date(day.getTime() - days * 24 * 60 * 60 * 1000);

    const customers = await this.prisma.party.findMany({
      where: { companyId, archivedAt: null, roles: { some: { role: 'CUSTOMER' } } },
      select: {
        id: true,
        nameFa: true,
        ownerUserId: true,
        phones: { where: { kind: 'MOBILE' }, select: { normalizedValue: true }, take: 1 },
      },
    });
    // Last purchase per party (operational-data note in the class doc).
    const lastSales = await this.prisma.salesDocument.groupBy({
      by: ['customerPartyId'],
      where: { companyId, status: { not: 'CANCELLED' } },
      _max: { documentDate: true },
    });
    const lastByParty = new Map(
      lastSales
        .filter((row) => row._max.documentDate !== null)
        .map((row) => [row.customerPartyId, row._max.documentDate as Date]),
    );

    const summary: ScanRuleSummary = {
      ruleId: rule.id,
      code: rule.code,
      triggerType: rule.triggerType,
      candidates: 0,
      executed: 0,
      skippedDuplicates: 0,
      conditionSkipped: 0,
    };
    for (const customer of customers) {
      const last = lastByParty.get(customer.id) ?? null;
      if (last && last.getTime() >= cutoff.getTime()) continue; // still active
      summary.candidates += 1;
      const daysSince = last
        ? Math.floor((day.getTime() - last.getTime()) / (24 * 60 * 60 * 1000))
        : null;
      const event = {
        partyId: customer.id,
        partyName: customer.nameFa,
        inactive: true,
        daysSinceLastPurchase: daysSince,
        lastPurchaseDate: last ? last.toISOString().slice(0, 10) : null,
        mobile: customer.phones[0]?.normalizedValue ?? null,
        recordOwnerId: customer.ownerUserId ?? '',
        date: dateKey,
      };
      const outcome = await this.runRuleInline(rule, event, `daily:${rule.id}:${dateKey}:${customer.id}`);
      if (outcome === 'executed') summary.executed += 1;
      else if (outcome === 'duplicate') summary.skippedDuplicates += 1;
      else summary.conditionSkipped += 1;
    }
    return summary;
  }

  private async scanPendingQuotations(rule: AutomationRule, dateKey: string): Promise<ScanRuleSummary> {
    const companyId = rule.companyId;
    const days = Number((rule.triggerConfig as { days?: number }).days ?? 7);
    const day = parseDayKey(dateKey);
    const cutoff = new Date(day.getTime() - days * 24 * 60 * 60 * 1000);

    const quotations = await this.prisma.salesDocument.findMany({
      where: { companyId, status: { in: ['QUOTATION', 'SENT'] }, documentDate: { lt: cutoff } },
      select: {
        id: true,
        documentNumber: true,
        status: true,
        documentDate: true,
        customerPartyId: true,
        salespersonUserId: true,
      },
    });

    const summary: ScanRuleSummary = {
      ruleId: rule.id,
      code: rule.code,
      triggerType: rule.triggerType,
      candidates: quotations.length,
      executed: 0,
      skippedDuplicates: 0,
      conditionSkipped: 0,
    };
    for (const quotation of quotations) {
      const ageDays = Math.floor((day.getTime() - quotation.documentDate.getTime()) / (24 * 60 * 60 * 1000));
      const event = {
        documentId: quotation.id,
        documentNumber: quotation.documentNumber,
        documentStatus: quotation.status,
        quotationPending: true,
        ageDays,
        customerPartyId: quotation.customerPartyId,
        recordOwnerId: quotation.salespersonUserId,
        date: dateKey,
      };
      const outcome = await this.runRuleInline(rule, event, `daily:${rule.id}:${dateKey}:${quotation.id}`);
      if (outcome === 'executed') summary.executed += 1;
      else if (outcome === 'duplicate') summary.skippedDuplicates += 1;
      else summary.conditionSkipped += 1;
    }
    return summary;
  }

  /**
   * Create the run row (idempotencyKey deduped — re-runs are silent no-ops)
   * and execute the action inline. Used by the daily scans; the PRICE_UPDATED
   * path goes through the queue instead.
   */
  private async runRuleInline(
    rule: AutomationRule,
    event: Record<string, unknown>,
    idempotencyKey: string,
  ): Promise<'executed' | 'duplicate' | 'condition-skipped'> {
    const matched = this.evaluateRule(rule, event);
    let run: AutomationRun;
    try {
      run = await this.prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          ruleVersion: rule.version,
          triggerPayload: toJson(event),
          status: 'PENDING',
          idempotencyKey,
          conditionsResult: toJson({ matched }),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return 'duplicate'; // already ran for this (rule, date, record)
      }
      throw error;
    }
    if (!matched) {
      await this.prisma.automationRun.update({
        where: { id: run.id },
        data: { status: 'SKIPPED', finishedAt: new Date(), conditionsResult: toJson({ matched: false }) },
      });
      return 'condition-skipped';
    }
    const policy = executionPolicyOf(rule);
    if (policy.delayMinutes > 0) {
      // Delayed scan execution: the run stays PENDING and the queue drives it
      // after the delay — the same durable `automation.run` path as events
      // (retries included). Idempotency is owned by the run row, so the job
      // key is per-run.
      await this.queueService.enqueue({
        jobType: 'automation.run',
        companyId: rule.companyId,
        payload: { runId: run.id },
        idempotencyKey: `auto-run:${run.id}`,
        priority: 'HIGH',
        maxAttempts: 1,
        delayMs: policy.delayMinutes * 60_000,
      });
      return 'executed';
    }
    await this.executeRun(run.id);
    return 'executed';
  }

  // ───────────────────── shared helpers ─────────────────────

  private evaluateRule(rule: AutomationRule, event: Record<string, unknown>): boolean {
    return evaluateConditions(
      (rule.conditionConfig ?? undefined) as RuleConditions,
      event,
    );
  }

  /**
   * Create the run row for an event; a duplicate idempotencyKey becomes a
   * SKIPPED run row (visible history, no double publish — p5-11).
   */
  private async tryCreateRun(
    rule: AutomationRule,
    idempotencyKey: string,
    event: Record<string, unknown>,
    matched: boolean,
  ): Promise<AutomationRun> {
    try {
      return await this.prisma.automationRun.create({
        data: {
          ruleId: rule.id,
          ruleVersion: rule.version,
          triggerPayload: toJson(event),
          status: 'PENDING',
          idempotencyKey,
          conditionsResult: toJson({ matched }),
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        // The (rule, variant, date) event already produced a run — record the
        // duplicate as SKIPPED without a key (the key column is unique).
        return await this.prisma.automationRun.create({
          data: {
            ruleId: rule.id,
            ruleVersion: rule.version,
            triggerPayload: toJson(event),
            status: 'SKIPPED',
            error: 'DUPLICATE_EVENT',
            conditionsResult: toJson({ duplicateOf: idempotencyKey, matched }),
          },
        });
      }
      throw error;
    }
  }

  /** Manual run (REQUIREMENTS §52 Manual Run) — see AutomationService.manualRun. */
  async manualRun(
    companyId: string,
    ruleId: string,
    input: { entityId?: string; date?: string },
  ): Promise<{ runs: AutomationRun[]; summaries?: ScanRuleSummary[] }> {
    const rule = await this.prisma.automationRule.findFirst({ where: { id: ruleId, companyId } });
    if (!rule) throw new NotFoundError('Automation rule not found', { ruleId });

    if (rule.triggerType === 'PRICE_UPDATED') {
      if (!input.entityId) throw new NotFoundError('entityId (variantId) is required for PRICE_UPDATED rules');
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: input.entityId, companyId },
        select: { id: true, sku: true, template: { select: { categoryId: true, brandId: true } } },
      });
      if (!variant) throw new NotFoundError('Product variant not found', { variantId: input.entityId });
      const price = await this.prisma.dailyPrice.findFirst({
        where: { companyId, productVariantId: variant.id },
        orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
      });
      const dateKey = price ? dayKeyOf(price.date) : todayKey();
      const event = {
        variantId: variant.id,
        variantSku: variant.sku,
        categoryId: variant.template.categoryId,
        brandId: variant.template.brandId,
        uomId: price?.uomId ?? null,
        price: price?.price.toString() ?? null,
        previousPrice: null,
        priceChanged: true,
        date: dateKey,
        source: price?.source ?? 'MANUAL',
      };
      const key = `auto:${rule.id}:${variant.id}:${dateKey}`;
      const matched = this.evaluateRule(rule, event as unknown as Record<string, unknown>);
      const run = await this.tryCreateRun(rule, key, event, matched);
      if (run.status === 'PENDING' && matched) {
        const policy = executionPolicyOf(rule);
        await this.queueService.enqueue({
          jobType: 'automation.run',
          companyId,
          payload: { runId: run.id },
          idempotencyKey: key,
          priority: 'HIGH',
          maxAttempts: 1,
          delayMs: policy.delayMinutes * 60_000,
        });
      }
      return { runs: [run] };
    }

    if (rule.triggerType === 'CUSTOMER_INACTIVE_DAYS' || rule.triggerType === 'QUOTATION_PENDING_DAYS') {
      const dateKey = input.date ?? todayKey();
      // p5c: audience-based SEND_SMS rules are bulk actions — they always run
      // as the once-per-date audience scan (entityId is not applicable).
      if (rule.actionType === 'SEND_SMS' && hasAudience(rule)) {
        const summaries = await this.scanSmsAudience(rule, dateKey);
        return { runs: [], summaries: [summaries] };
      }
      // Single-record manual run OR a full scan of this rule.
      if (input.entityId && rule.triggerType === 'CUSTOMER_INACTIVE_DAYS') {
        const customer = await this.prisma.party.findFirst({
          where: { id: input.entityId, companyId },
          select: { id: true, nameFa: true, ownerUserId: true },
        });
        if (!customer) throw new NotFoundError('Party not found', { partyId: input.entityId });
        const event = {
          partyId: customer.id,
          partyName: customer.nameFa,
          inactive: true,
          daysSinceLastPurchase: null,
          recordOwnerId: customer.ownerUserId ?? '',
          date: dateKey,
        };
        const run = await this.runRuleInline(rule, event, `daily:${rule.id}:${dateKey}:${customer.id}`);
        return { runs: [] , summaries: [await this.summarizeSingle(rule, run)] };
      }
      if (input.entityId && rule.triggerType === 'QUOTATION_PENDING_DAYS') {
        const quotation = await this.prisma.salesDocument.findFirst({
          where: { id: input.entityId, companyId },
          select: { id: true, documentNumber: true, status: true, documentDate: true, customerPartyId: true, salespersonUserId: true },
        });
        if (!quotation) throw new NotFoundError('Sales document not found', { documentId: input.entityId });
        const event = {
          documentId: quotation.id,
          documentNumber: quotation.documentNumber,
          documentStatus: quotation.status,
          quotationPending: true,
          ageDays: null,
          recordOwnerId: quotation.salespersonUserId,
          date: dateKey,
        };
        const run = await this.runRuleInline(rule, event, `daily:${rule.id}:${dateKey}:${quotation.id}`);
        return { runs: [], summaries: [await this.summarizeSingle(rule, run)] };
      }
      const summaries = await this.dailyScan({ companyId, date: dateKey, ruleId: rule.id });
      return { runs: [], summaries };
    }

    // MANUAL trigger: run against an arbitrary entity id.
    const event = { entityId: input.entityId ?? null, date: input.date ?? todayKey() };
    const key = `manual:${rule.id}:${input.entityId ?? ''}:${event.date}`;
    const matched = this.evaluateRule(rule, event);
    const run = await this.tryCreateRun(rule, key, event, matched);
    if (run.status === 'PENDING' && matched) {
      const policy = executionPolicyOf(rule);
      if (policy.delayMinutes > 0) {
        // Delayed execution: durable PENDING run + one queue delivery (the
        // run row owns idempotency; the retry policy rides on executeRun).
        await this.queueService.enqueue({
          jobType: 'automation.run',
          companyId,
          payload: { runId: run.id },
          idempotencyKey: `auto-run:${run.id}`,
          priority: 'HIGH',
          maxAttempts: 1,
          delayMs: policy.delayMinutes * 60_000,
        });
      } else {
        await this.executeRun(run.id);
      }
    }
    // Re-read AFTER execution — the caller gets the final status, not the
    // pre-execution snapshot.
    return { runs: [await this.prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } })] };
  }

  private async summarizeSingle(
    rule: AutomationRule,
    outcome: 'executed' | 'duplicate' | 'condition-skipped',
  ): Promise<ScanRuleSummary> {
    return {
      ruleId: rule.id,
      code: rule.code,
      triggerType: rule.triggerType,
      candidates: 1,
      executed: outcome === 'executed' ? 1 : 0,
      skippedDuplicates: outcome === 'duplicate' ? 1 : 0,
      conditionSkipped: outcome === 'condition-skipped' ? 1 : 0,
    };
  }

  /**
   * Dry run (Phase 9C): build the SAME event a real run would use, evaluate
   * the rule's conditions and compute what the action WOULD do — WITHOUT any
   * side effect (no run rows, no batches, no jobs, no notifications, no
   * activities). Used by the /rules/:id/dry-run endpoint to validate rules
   * before enabling them.
   */
  async dryRun(
    companyId: string,
    ruleId: string,
    input: { entityId?: string; date?: string },
  ): Promise<{
    matched: boolean;
    conditionsResult: boolean;
    event: Record<string, unknown>;
    policy: AutomationExecutionPolicy;
    wouldDo: Record<string, unknown>;
  }> {
    const rule = await this.prisma.automationRule.findFirst({ where: { id: ruleId, companyId } });
    if (!rule) throw new NotFoundError('Automation rule not found', { ruleId });
    const event = await this.buildEventFor(companyId, rule, input);
    const matched = this.evaluateRule(rule, event);
    const policy = executionPolicyOf(rule);
    const wouldDo = matched
      ? await this.wouldDoOf(companyId, rule, event)
      : { action: rule.actionType, skipped: 'CONDITION_NOT_MATCHED' };
    return { matched, conditionsResult: matched, event, policy, wouldDo };
  }

  /** The exact event a real run would see (shared by manualRun + dryRun). */
  private async buildEventFor(
    companyId: string,
    rule: AutomationRule,
    input: { entityId?: string; date?: string },
  ): Promise<Record<string, unknown>> {
    const dateKey = input.date ?? todayKey();
    if (rule.triggerType === 'PRICE_UPDATED') {
      if (!input.entityId) throw new NotFoundError('entityId (variantId) is required for PRICE_UPDATED rules');
      const variant = await this.prisma.productVariant.findFirst({
        where: { id: input.entityId, companyId },
        select: { id: true, sku: true, template: { select: { categoryId: true, brandId: true } } },
      });
      if (!variant) throw new NotFoundError('Product variant not found', { variantId: input.entityId });
      const price = await this.prisma.dailyPrice.findFirst({
        where: { companyId, productVariantId: variant.id },
        orderBy: [{ date: 'desc' }, { updatedAt: 'desc' }],
      });
      return {
        variantId: variant.id,
        variantSku: variant.sku,
        categoryId: variant.template.categoryId,
        brandId: variant.template.brandId,
        uomId: price?.uomId ?? null,
        price: price?.price.toString() ?? null,
        previousPrice: null,
        priceChanged: true,
        date: price ? dayKeyOf(price.date) : dateKey,
        source: price?.source ?? 'MANUAL',
      };
    }
    if (rule.triggerType === 'CUSTOMER_INACTIVE_DAYS' && input.entityId) {
      const customer = await this.prisma.party.findFirst({
        where: { id: input.entityId, companyId },
        select: { id: true, nameFa: true, ownerUserId: true },
      });
      if (!customer) throw new NotFoundError('Party not found', { partyId: input.entityId });
      return {
        partyId: customer.id,
        partyName: customer.nameFa,
        inactive: true,
        daysSinceLastPurchase: null,
        recordOwnerId: customer.ownerUserId ?? '',
        date: dateKey,
      };
    }
    if (rule.triggerType === 'QUOTATION_PENDING_DAYS' && input.entityId) {
      const quotation = await this.prisma.salesDocument.findFirst({
        where: { id: input.entityId, companyId },
        select: { id: true, documentNumber: true, status: true, documentDate: true, customerPartyId: true, salespersonUserId: true },
      });
      if (!quotation) throw new NotFoundError('Sales document not found', { documentId: input.entityId });
      return {
        documentId: quotation.id,
        documentNumber: quotation.documentNumber,
        documentStatus: quotation.status,
        quotationPending: true,
        ageDays: null,
        customerPartyId: quotation.customerPartyId,
        recordOwnerId: quotation.salespersonUserId,
        date: dateKey,
      };
    }
    // Scan rules without an entityId: audience summary / aggregate event.
    if (rule.actionType === 'SEND_SMS' && hasAudience(rule)) {
      const audience = ((rule.actionConfig ?? {}) as { audience?: SmsAudienceConfig }).audience;
      const members = await this.resolveAudience(companyId, audience as SmsAudienceConfig);
      return { date: dateKey, scanType: 'SMS_AUDIENCE', audienceType: audience?.type, audienceCount: members.length };
    }
    return { entityId: input.entityId ?? null, date: dateKey };
  }

  /** What the action WOULD do — read-only computations only. */
  private async wouldDoOf(
    companyId: string,
    rule: AutomationRule,
    event: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (rule.actionType) {
      case 'PUBLISH_PRICE': {
        const actionConfig = (rule.actionConfig ?? {}) as { channels?: PublishChannel[] };
        const triggerConfig = (rule.triggerConfig ?? {}) as { channels?: PublishChannel[] };
        const channels = actionConfig.channels?.length
          ? actionConfig.channels
          : triggerConfig.channels?.length
            ? triggerConfig.channels
            : ['WEBSITE' as PublishChannel];
        return {
          action: 'PUBLISH_PRICE',
          batch: {
            priceDate: String(event.date ?? todayKey()),
            channels,
            variantIds: [event.variantId],
          },
        };
      }
      case 'SEND_SMS': {
        const actionConfig = (rule.actionConfig ?? {}) as { text?: string; audience?: SmsAudienceConfig };
        if (hasAudience(rule)) {
          const resolved = await this.resolveAudience(companyId, actionConfig.audience as SmsAudienceConfig);
          const members = resolved.slice(0, SMS_AUDIENCE_CAP);
          return {
            action: 'SEND_SMS',
            audienceType: actionConfig.audience?.type,
            audienceResolved: resolved.length,
            wouldQueue: members.filter((m) => m.mobile).length,
            skippedNoMobile: members.filter((m) => !m.mobile).length,
            cap: SMS_AUDIENCE_CAP,
            // At most 20 members in the preview — presence flags, no mobile numbers.
            preview: members.slice(0, 20).map((m) => ({ partyId: m.partyId, nameFa: m.nameFa, hasMobile: Boolean(m.mobile) })),
          };
        }
        return {
          action: 'SEND_SMS',
          to: String(event.mobile ?? '') || null,
          text: interpolate(actionConfig.text ?? rule.nameFa, event),
        };
      }
      case 'CREATE_NOTIFICATION': {
        const actionConfig = (rule.actionConfig ?? {}) as {
          title?: string;
          body?: string;
          recipients?: RecipientConfig[];
        };
        const recipients = actionConfig.recipients?.length
          ? actionConfig.recipients
          : [{ type: 'RECORD_OWNER' as const, value: '' }];
        const userIds = await this.notificationService.resolveRecipients(companyId, recipients, event);
        return {
          action: 'CREATE_NOTIFICATION',
          recipientCount: userIds.length,
          title: interpolate(actionConfig.title ?? rule.nameFa, event),
          body: interpolate(actionConfig.body ?? '', event),
        };
      }
      case 'CREATE_ACTIVITY': {
        const actionConfig = (rule.actionConfig ?? {}) as { title?: string; typeCode?: string; days?: number };
        const related = this.relatedEntityOf(event);
        return {
          action: 'CREATE_ACTIVITY',
          typeCode: actionConfig.typeCode ?? 'FOLLOW_UP',
          title: interpolate(actionConfig.title ?? rule.nameFa, event),
          related: related ?? null,
          dueInDays: actionConfig.days ?? null,
        };
      }
      default:
        return { action: rule.actionType };
    }
  }

  /** Schedule the next self-perpetuating daily scan (06:00 local). */
  async scheduleNextScan(from: Date = new Date()): Promise<string | null> {
    const candidate = new Date(from);
    candidate.setHours(6, 0, 0, 0);
    if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
    const dateKey = dayKeyOf(candidate);
    const job = await this.queueService.enqueue({
      jobType: 'automation.daily_scan',
      payload: { date: dateKey },
      delayMs: Math.max(candidate.getTime() - Date.now(), 0),
      idempotencyKey: `automation.daily_scan:${dateKey}`,
      priority: 'LOW',
    });
    return job.id;
  }
}
