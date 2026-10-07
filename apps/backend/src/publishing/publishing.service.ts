import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, PublishBatch, PublishBatchItem, PublishChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { SequencesService } from '../sequences/sequences.service';
import { QueueService } from '../queue/queue.service';
import { QueueHandler } from '../queue/queue.handlers';
import { Prisma as PrismaNamespace } from '@prisma/client';
import {
  PUBLISHING_ADAPTERS,
  PublishingAdapter,
  PublishingAdapterConfig,
  RenderedPublishPayload,
  adapterMapOf,
} from './publishing-adapter';
import { renderBody } from './publishing-render';
import { renderedToJson } from './publishing-template.service';
import { parseDayKey, todayKey } from '../pricing/day';
import { CreatePublishBatchDto, PublishBatchQueryDto } from './publishing.dto';

/** JSON-safe coercion for provider responses (Prisma InputJsonValue). */
function jsonOf(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * Queue-job idempotency key for a publish item. The FIRST enqueue (attempt
 * generation 0) uses `publish:{itemId}`; RETRIES must create a NEW queue row
 * and queue_jobs is unique on (companyId, idempotencyKey) — so retry keys are
 * suffixed with the attempt generation `publish:{itemId}:a{attemptCount}`,
 * which stays deterministic and dedupes double-click retries.
 */
export function publishItemIdempotencyKey(itemId: string, attemptCount: number): string {
  return attemptCount === 0 ? `publish:${itemId}` : `publish:${itemId}:a${attemptCount}`;
}

/**
 * Publishing engine (Phase 5, REQUIREMENTS §18, §52, §70-73): one batch fans
 * out one item per (channel, destination); each item is executed by a queue
 * job through a channel adapter. One channel failing never blocks the others
 * (independent items). Duplicate publishing is prevented by the DB unique
 * (batchId, channel, destination) — duplicate inserts are SKIPPED, not fatal.
 */
@Injectable()
export class PublishingService {
  private readonly logger = new Logger('PublishingService');
  private adapterMap: Map<PublishChannel, PublishingAdapter> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly sequencesService: SequencesService,
    private readonly queueService: QueueService,
    @Inject(PUBLISHING_ADAPTERS) private readonly adapters: PublishingAdapter[],
  ) {}

  private mapAdapters(): Map<PublishChannel, PublishingAdapter> {
    if (!this.adapterMap) this.adapterMap = adapterMapOf(this.adapters);
    return this.adapterMap;
  }

  // ───────────────────────────── batch creation ─────────────────────────────

  async createBatch(
    companyId: string,
    dto: CreatePublishBatchDto,
    actor: { id?: string | null; username: string },
    ctx: RequestContext,
  ) {
    const dayKey = dto.priceDate ?? todayKey();
    const day = parseDayKey(dayKey);
    if (!dto.channels?.length) {
      throw new ValidationError('At least one channel is required');
    }

    // Dedupe requested (channel, destination) pairs — the second one is a
    // skip (mirrors the DB unique (batchId, channel, destination)).
    const seen = new Set<string>();
    const requestSkipped: { channel: PublishChannel; destination: string }[] = [];
    const entries = dto.channels
      .map((entry) => ({
        channel: entry.channel,
        destination: entry.destination ?? '',
        templateCode: entry.templateCode,
      }))
      .filter((entry) => {
        const key = `${entry.channel}:${entry.destination}`;
        if (seen.has(key)) {
          requestSkipped.push({ channel: entry.channel, destination: entry.destination });
          return false;
        }
        seen.add(key);
        return true;
      });

    // Resolve the variant set.
    let variantIds: string[];
    if (dto.variantIds && dto.variantIds.length > 0) {
      const rows = await this.prisma.productVariant.findMany({
        where: { id: { in: dto.variantIds }, companyId },
        select: { id: true },
      });
      variantIds = rows.map((r) => r.id);
    } else if (dto.categoryId) {
      const rows = await this.prisma.productVariant.findMany({
        where: { companyId, active: true, template: { categoryId: dto.categoryId } },
        select: { id: true },
      });
      variantIds = rows.map((r) => r.id);
    } else {
      throw new ValidationError('variantIds or categoryId is required');
    }
    if (variantIds.length === 0) {
      throw new ValidationError('NO_VARIANTS_MATCHED', { categoryId: dto.categoryId ?? null });
    }

    // That day's prices joined with variant/template/brand/uom.
    const priceRows = await this.prisma.dailyPrice.findMany({
      where: { companyId, date: day, productVariantId: { in: variantIds } },
      include: {
        uom: { select: { id: true, symbol: true } },
        productVariant: {
          select: {
            id: true,
            sku: true,
            nameFa: true,
            template: {
              select: { id: true, nameFa: true, brand: { select: { nameFa: true } } },
            },
          },
        },
      },
    });
    if (priceRows.length === 0) {
      throw new ValidationError('NO_PRICES_FOR_DATE', { date: dayKey });
    }
    const attributeVars = await this.attributeVarsFor(companyId, priceRows.map((r) => r.productVariantId));

    const batchNumber = await this.nextBatchNumber(companyId);
    const batch = await this.prisma.publishBatch.create({
      data: {
        companyId,
        batchNumber,
        priceDate: day,
        notes: dto.notes ?? null,
        createdBy: actor.id ?? null,
      },
    });

    const items: PublishBatchItem[] = [];
    const skipped: { channel: PublishChannel; destination: string }[] = [...requestSkipped];
    for (const entry of entries) {
      const template = await this.resolveTemplate(companyId, entry.channel, entry.templateCode);
      if (!template) {
        throw new ValidationError('NO_PUBLISHING_TEMPLATE', {
          channel: entry.channel,
          templateCode: entry.templateCode ?? null,
        });
      }
      const rendered = this.renderPayload(template, priceRows, attributeVars, dayKey);
      try {
        const item = await this.prisma.publishBatchItem.create({
          data: {
            companyId,
            batchId: batch.id,
            channel: entry.channel,
            destination: entry.destination,
            templateId: template.id,
            renderedPayload: renderedToJson(rendered),
            priceDate: day,
          },
        });
        items.push(item);
      } catch (error) {
        // Duplicate publish prevention: (batchId, channel, destination) —
        // the loser is SKIPPED, never a failure.
        if (
          error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          skipped.push({ channel: entry.channel, destination: entry.destination });
          continue;
        }
        throw error;
      }
    }

    await this.auditService.record({
      entityType: 'publish_batch',
      entityId: batch.id,
      action: 'CREATE',
      companyId,
      actor: { id: actor.id ?? undefined, username: actor.username },
      newValues: {
        batchNumber,
        priceDate: dayKey,
        channels: entries.map((e) => e.channel),
        items: items.length,
        skippedDuplicates: skipped.length,
        variants: priceRows.length,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // One queue job per item — a channel failure never blocks the others.
    const queueJobIds: string[] = [];
    for (const item of items) {
      const job = await this.queueService.enqueue({
        jobType: 'publish.batch_item',
        companyId,
        payload: { companyId, itemId: item.id },
        idempotencyKey: publishItemIdempotencyKey(item.id, 0),
        priority: 'HIGH',
      });
      await this.prisma.publishBatchItem.update({
        where: { id: item.id },
        data: { queuedJobId: job.id },
      });
      queueJobIds.push(job.id);
    }

    return {
      batch: { ...batch, itemsCount: items.length },
      items,
      skippedDuplicates: skipped,
      queueJobIds,
    };
  }

  /** Auto-batch entry point for the automation PUBLISH_PRICE action. */
  async createAutoBatch(
    companyId: string,
    input: { priceDate: string; channels: PublishChannel[]; variantIds: string[]; automationRunId: string },
  ) {
    return this.createBatch(
      companyId,
      {
        priceDate: input.priceDate,
        channels: input.channels.map((channel) => ({ channel })),
        variantIds: input.variantIds,
        notes: `automation:${input.automationRunId}`,
      },
      // The automation actor is not a user; createdBy stays null.
      { id: null, username: 'automation' },
      {},
    );
  }

  private async nextBatchNumber(companyId: string): Promise<string> {
    try {
      return (await this.sequencesService.allocate(companyId, 'PUBLISH_BATCH')).number;
    } catch (error) {
      if (!(error instanceof NotFoundError)) throw error;
      // Self-heal for databases seeded before Phase 5: create the sequence
      // (idempotent) and allocate again.
      try {
        await this.prisma.sequence.create({
          data: {
            companyId,
            documentType: 'PUBLISH_BATCH',
            name: 'Publish batch',
            prefix: 'PB',
            padding: 5,
          },
        });
      } catch (createError) {
        if (
          !(
            createError instanceof PrismaNamespace.PrismaClientKnownRequestError &&
            createError.code === 'P2002'
          )
        ) {
          throw createError;
        }
      }
      return (await this.sequencesService.allocate(companyId, 'PUBLISH_BATCH')).number;
    }
  }

  private async resolveTemplate(
    companyId: string,
    channel: PublishChannel,
    templateCode?: string,
  ) {
    if (templateCode) {
      return this.prisma.publishingTemplate.findUnique({
        where: { companyId_channel_code: { companyId, channel, code: templateCode } },
      });
    }
    return this.prisma.publishingTemplate.findFirst({
      where: { companyId, channel, isActive: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async attributeVarsFor(
    companyId: string,
    variantIds: string[],
  ): Promise<Map<string, { size: string; grade: string; extra: Record<string, string> }>> {
    const result = new Map<string, { size: string; grade: string; extra: Record<string, string> }>();
    if (variantIds.length === 0) return result;
    const rows = await this.prisma.variantAttributeValue.findMany({
      where: { variantId: { in: variantIds }, variant: { companyId } },
      include: {
        attribute: { select: { code: true } },
        attributeValue: { select: { valueFa: true } },
      },
    });
    for (const row of rows) {
      const entry = result.get(row.variantId) ?? { size: '', grade: '', extra: {} };
      const code = row.attribute.code.toLowerCase();
      const value = row.attributeValue.valueFa;
      if (code === 'size') entry.size = value;
      else if (code === 'grade') entry.grade = value;
      entry.extra[code] = value;
      result.set(row.variantId, entry);
    }
    return result;
  }

  /**
   * Render one payload per (channel, destination): every variant row is run
   * through the template body, then the lines are GROUPED by product
   * template (ordered by template name, then sku) and joined with newlines.
   */
  private renderPayload(
    template: { id: string; code: string; bodyTemplate: string },
    priceRows: {
      productVariantId: string;
      price: Prisma.Decimal;
      uom: { symbol: string };
      productVariant: {
        id: string;
        sku: string;
        template: { id: string; nameFa: string; brand: { nameFa: string } | null };
      };
    }[],
    attributeVars: Map<string, { size: string; grade: string; extra: Record<string, string> }>,
    dayKey: string,
  ): RenderedPublishPayload {
    const lines = priceRows.map((row) => {
      const attrs = attributeVars.get(row.productVariantId) ?? { size: '', grade: '', extra: {} };
      const vars: Record<string, string> = {
        product: row.productVariant.template.nameFa,
        variantSku: row.productVariant.sku,
        size: attrs.size,
        grade: attrs.grade,
        brand: row.productVariant.template.brand?.nameFa ?? '',
        price: row.price.toString(),
        date: dayKey,
        uom: row.uom.symbol,
        ...attrs.extra,
      };
      const rendered = renderBody(template.bodyTemplate, vars);
      return {
        productTemplateId: row.productVariant.template.id,
        product: row.productVariant.template.nameFa,
        variantId: row.productVariantId,
        variantSku: row.productVariant.sku,
        text: rendered.text,
        warnings: rendered.warnings,
      };
    });

    const sorted = [...lines].sort(
      (a, b) =>
        a.product.localeCompare(b.product, 'fa') || a.variantSku.localeCompare(b.variantSku),
    );
    return {
      messageText: sorted.map((l) => l.text).join('\n'),
      lines: sorted.map(({ warnings, ...line }) => line),
      templateId: template.id,
      templateCode: template.code,
      warnings: [...new Set(lines.flatMap((l) => l.warnings))],
      variantIds: priceRows.map((r) => r.productVariantId),
    };
  }

  // ─────────────────────────── item lifecycle ───────────────────────────

  /** retryItem: FAILED/CANCELLED → PENDING, re-enqueued (attempt preserved). */
  async retryItem(
    companyId: string,
    itemId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const item = await this.prisma.publishBatchItem.findFirst({
      where: { id: itemId, companyId },
    });
    if (!item) throw new NotFoundError('Publish batch item not found', { itemId });
    if (item.status !== 'FAILED' && item.status !== 'CANCELLED') {
      throw new ValidationError('Only FAILED or CANCELLED items can be retried', {
        status: item.status,
      });
    }

    const updated = await this.prisma.publishBatchItem.update({
      where: { id: item.id },
      data: { status: 'PENDING', startedAt: null, finishedAt: null },
    });
    const job = await this.queueService.enqueue({
      jobType: 'publish.batch_item',
      companyId,
      payload: { companyId, itemId: item.id },
      idempotencyKey: publishItemIdempotencyKey(item.id, item.attemptCount),
      priority: 'HIGH',
    });
    await this.prisma.publishBatchItem.update({
      where: { id: item.id },
      data: { queuedJobId: job.id },
    });
    await this.prisma.publishBatch.update({
      where: { id: item.batchId },
      data: { status: 'PROCESSING', finishedAt: null },
    });
    await this.auditService.record({
      entityType: 'publish_batch_item',
      entityId: item.id,
      action: 'RETRY',
      companyId,
      actor,
      oldValues: { status: item.status, lastError: item.lastError },
      newValues: { status: 'PENDING', attemptCount: item.attemptCount, queueJobId: job.id },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ...updated, queuedJobId: job.id, queueJobId: job.id };
  }

  /** cancelItem: PENDING/FAILED → CANCELLED (+ best-effort queue cancel). */
  async cancelItem(
    companyId: string,
    itemId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const item = await this.prisma.publishBatchItem.findFirst({
      where: { id: itemId, companyId },
    });
    if (!item) throw new NotFoundError('Publish batch item not found', { itemId });
    if (item.status !== 'PENDING' && item.status !== 'FAILED') {
      throw new ValidationError('Only PENDING or FAILED items can be cancelled', {
        status: item.status,
      });
    }

    const updated = await this.prisma.publishBatchItem.update({
      where: { id: item.id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    if (item.queuedJobId) {
      try {
        await this.queueService.cancel(item.queuedJobId);
      } catch (error) {
        // Best-effort: the queue row may already be terminal.
        this.logger.debug(
          `Queue cancel for ${item.queuedJobId} skipped: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    await this.auditService.record({
      entityType: 'publish_batch_item',
      entityId: item.id,
      action: 'CANCEL',
      companyId,
      actor,
      oldValues: { status: item.status },
      newValues: { status: 'CANCELLED' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    await this.recomputeBatchStatus(item.batchId);
    return updated;
  }

  // ───────────────────────────── queries ─────────────────────────────

  async listBatches(companyId: string, query: PublishBatchQueryDto) {
    const where: Prisma.PublishBatchWhereInput = {
      companyId,
      status: query.status as PublishBatch['status'] | undefined,
      ...(query.date ? { priceDate: parseDayKey(query.date) } : {}),
      ...(query.channel ? { items: { some: { channel: query.channel } } } : {}),
    };
    const [batches, total] = await Promise.all([
      this.prisma.publishBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { _count: { select: { items: true } } },
      }),
      this.prisma.publishBatch.count({ where }),
    ]);
    return {
      items: batches.map(({ _count, ...batch }) => ({ ...batch, itemsCount: _count.items })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Batch detail — items include ALL failure details (error, provider response). */
  async getBatch(companyId: string, id: string) {
    const batch = await this.prisma.publishBatch.findFirst({
      where: { id, companyId },
      include: {
        items: {
          orderBy: { createdAt: 'asc' },
          include: { template: { select: { id: true, code: true, nameFa: true, channel: true } } },
        },
      },
    });
    if (!batch) throw new NotFoundError('Publish batch not found', { id });
    return batch;
  }

  /**
   * Recompute batch status from its items:
   *   any PENDING/PROCESSING → PROCESSING; all SUCCESS → COMPLETED;
   *   all FAILED → FAILED; all CANCELLED → CANCELLED; otherwise PARTIAL.
   */
  async recomputeBatchStatus(batchId: string): Promise<string> {
    const grouped = await this.prisma.publishBatchItem.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return 'PENDING';

    const n = (status: string) => counts.get(status as PublishBatchItem['status']) ?? 0;
    const open = n('PENDING') + n('PROCESSING');
    let status: PublishBatch['status'];
    if (open > 0) status = 'PROCESSING';
    else if (n('SUCCESS') === total) status = 'COMPLETED';
    else if (n('FAILED') === total) status = 'FAILED';
    else if (n('CANCELLED') === total) status = 'CANCELLED';
    else status = 'PARTIAL';

    await this.prisma.publishBatch.update({
      where: { id: batchId },
      data: {
        status,
        ...(status === 'PROCESSING' ? {} : { finishedAt: new Date() }),
      },
    });
    return status;
  }
}

/**
 * Queue handler `publish.batch_item` (REQUIREMENTS §18: "هر Channel Job
 * مستقل باشد"). Deterministic + idempotent: SUCCESS/CANCELLED/PROCESSING
 * items are never re-sent, so a redelivered queue job cannot double-publish
 * (p5-09). Business failures are recorded ON THE ITEM (FAILED + lastError +
 * providerResponse) and the queue job itself completes — only infrastructure
 * errors propagate to the queue retry machinery.
 */
@Injectable()
export class PublishBatchItemHandler implements QueueHandler {
  readonly type = 'publish.batch_item';

  private adapterMap: Map<PublishChannel, PublishingAdapter> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUBLISHING_ADAPTERS) private readonly adapters: PublishingAdapter[],
  ) {}

  private mapAdapters(): Map<PublishChannel, PublishingAdapter> {
    if (!this.adapterMap) this.adapterMap = adapterMapOf(this.adapters);
    return this.adapterMap;
  }

  async handle(payload: unknown): Promise<void> {
    const { itemId } = (payload ?? {}) as { itemId?: string };
    if (!itemId) return;

    const item = await this.prisma.publishBatchItem.findUnique({ where: { id: itemId } });
    if (!item) return;
    // Idempotent re-run — never double-send an item that already finished or
    // is being processed by another worker.
    if (item.status === 'SUCCESS' || item.status === 'CANCELLED' || item.status === 'PROCESSING') {
      return;
    }

    await this.prisma.publishBatchItem.update({
      where: { id: item.id },
      data: {
        status: 'PROCESSING',
        attemptCount: { increment: 1 },
        ...(item.startedAt ? {} : { startedAt: new Date() }),
      },
    });

    const config = await this.prisma.integrationConfig.findFirst({
      where: { companyId: item.companyId, type: item.channel, isActive: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (!config) {
      await this.finishFailure(item, 'NO_ADAPTER_CONFIG', {
        error: 'NO_ADAPTER_CONFIG',
        channel: item.channel,
      });
      return;
    }
    const adapter = this.mapAdapters().get(item.channel);
    if (!adapter) {
      await this.finishFailure(item, 'NO_ADAPTER', { error: 'NO_ADAPTER', channel: item.channel });
      return;
    }

    const rendered = (item.renderedPayload ?? {
      messageText: '',
      lines: [],
      variantIds: [],
    }) as unknown as RenderedPublishPayload;
    try {
      const result = await adapter.send(
        rendered,
        (config.config ?? {}) as PublishingAdapterConfig,
        item.destination,
      );
      if (result.ok) {
        await this.prisma.publishBatchItem.update({
          where: { id: item.id },
          data: {
            status: 'SUCCESS',
            finishedAt: new Date(),
            lastError: null,
            providerResponse: jsonOf(result.providerResponse),
          },
        });
      } else {
        await this.finishFailure(
          item,
          String(result.providerResponse.error ?? 'PROVIDER_FAILED'),
          result.providerResponse,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finishFailure(item, message, { error: message });
      return;
    }
    await this.recompute(item.batchId);
  }

  private async finishFailure(
    item: PublishBatchItem,
    lastError: string,
    providerResponse: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.publishBatchItem.update({
      where: { id: item.id },
      data: {
        status: 'FAILED',
        finishedAt: new Date(),
        lastError,
        providerResponse: jsonOf(providerResponse),
      },
    });
    await this.recompute(item.batchId);
  }

  private async recompute(batchId: string): Promise<void> {
    const grouped = await this.prisma.publishBatchItem.groupBy({
      by: ['status'],
      where: { batchId },
      _count: { _all: true },
    });
    const counts = new Map(grouped.map((g) => [g.status, g._count._all]));
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return;
    const n = (status: string) => counts.get(status as PublishBatchItem['status']) ?? 0;
    let status: PublishBatch['status'];
    if (n('PENDING') + n('PROCESSING') > 0) status = 'PROCESSING';
    else if (n('SUCCESS') === total) status = 'COMPLETED';
    else if (n('FAILED') === total) status = 'FAILED';
    else if (n('CANCELLED') === total) status = 'CANCELLED';
    else status = 'PARTIAL';
    await this.prisma.publishBatch.update({
      where: { id: batchId },
      data: {
        status,
        ...(status === 'PROCESSING' ? {} : { finishedAt: new Date() }),
      },
    });
  }
}
