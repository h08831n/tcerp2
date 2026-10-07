import { Injectable, Logger } from '@nestjs/common';
import { AutomationRule, AutomationRun, Prisma, PublishChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotFoundError } from '../common/errors';
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
      await this.queueService.enqueue({
        jobType: 'automation.run',
        companyId,
        payload: { runId: run.id },
        idempotencyKey: key,
        priority: 'HIGH',
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
          // No Activity model in the Phase 5 schema yet — a follow-up reminder
          // notification tagged `automation_activity` is created instead.
          result = await this.actionCreateNotification(rule, companyId, event, run.id, true);
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
      return await this.prisma.automationRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date(), error: message },
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

  private async actionSendSms(
    rule: AutomationRule,
    companyId: string,
    event: Record<string, unknown>,
    run: AutomationRun,
  ) {
    const to = String(event.mobile ?? '') || null;
    if (!to) return { queued: false, reason: 'NO_MOBILE' };
    const actionConfig = (rule.actionConfig ?? {}) as { text?: string };
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
        rule.triggerType === 'CUSTOMER_INACTIVE_DAYS'
          ? await this.scanInactiveCustomers(rule, dateKey)
          : await this.scanPendingQuotations(rule, dateKey);
      summaries.push(summary);
    }
    return summaries;
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
        await this.queueService.enqueue({
          jobType: 'automation.run',
          companyId,
          payload: { runId: run.id },
          idempotencyKey: key,
          priority: 'HIGH',
        });
      }
      return { runs: [run] };
    }

    if (rule.triggerType === 'CUSTOMER_INACTIVE_DAYS' || rule.triggerType === 'QUOTATION_PENDING_DAYS') {
      const dateKey = input.date ?? todayKey();
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
      await this.executeRun(run.id);
    }
    return { runs: [run] };
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
