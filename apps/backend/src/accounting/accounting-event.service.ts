import { Injectable, Logger } from '@nestjs/common';
import { AccountingEventType, PostingMeasure, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JournalService, JournalLineInput } from './journal.service';
import { ValidationError } from '../common/errors';

type Tx = Prisma.TransactionClient;

export interface EmitInput {
  companyId: string;
  eventType: AccountingEventType;
  sourceEntityType: string;
  sourceEntityId: string;
  idempotencyKey: string;
  /** Measures consumed by posting rule lines. */
  measures: Partial<Record<PostingMeasure, Prisma.Decimal>>;
  analytics: {
    customerId?: string | null;
    supplierId?: string | null;
    salespersonUserId?: string | null;
    productVariantId?: string | null;
  };
  description?: string;
  /** true on INVENTORY_REVERSAL / reversed flows → sides swap. */
  reversal?: boolean;
  entryDate?: Date;
}

/**
 * Operational Event → PostingRule → JournalEntry (Phase 7B, docs/05 §2).
 * A missing/disabled rule → AccountingEvent SKIPPED (documented, not an
 * error). Posting failures (closed period, unbalanced) mark the event FAILED
 * and NEVER block the operational mutation — retry via POST
 * /accounting/events/:id/post.
 */
@Injectable()
export class AccountingEventService {
  private readonly logger = new Logger('AccountingEvent');

  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
  ) {}

  async emit(input: EmitInput): Promise<void> {
    const event = await this.prisma.accountingEvent.upsert({
      where: { idempotencyKey: input.idempotencyKey },
      create: {
        companyId: input.companyId,
        eventType: input.eventType,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        // Prisma Decimal values are not JSON-serializable — stringify each
        // measure so the event log stores exact decimal strings. entryDate is
        // the FINANCIAL date — persisted so a retry reproduces it exactly.
        payload: {
          measures: Object.fromEntries(
            Object.entries(input.measures).map(([k, v]) => [k, v.toString()]),
          ),
          analytics: input.analytics,
          reversal: input.reversal ?? false,
          entryDate: input.entryDate ? input.entryDate.toISOString() : null,
        } as Prisma.InputJsonValue,
        status: 'FAILED',
        idempotencyKey: input.idempotencyKey,
      },
      update: {},
    });
    if (event.status === 'POSTED') return; // idempotent
    if (event.journalEntryId) {
      // A prior attempt already created the journal but failed to persist the
      // status update — REPAIR the status instead of posting a second,
      // duplicate financial entry for the same event.
      await this.prisma.accountingEvent.update({
        where: { id: event.id },
        data: { status: 'POSTED', postedAt: event.postedAt ?? new Date(), error: null },
      });
      return;
    }
    try {
      const rule = await this.prisma.postingRule.findFirst({
        where: { companyId: input.companyId, eventType: input.eventType, enabled: true },
        include: { lines: { orderBy: { order: 'asc' } } },
      });
      if (!rule || rule.lines.length === 0) {
        await this.prisma.accountingEvent.update({
          where: { id: event.id },
          data: { status: 'SKIPPED', error: 'NO_POSTING_RULE' },
        });
        return;
      }
      const lines: JournalLineInput[] = rule.lines.map((l) => {
        const amount = input.measures[l.measure] ?? new Prisma.Decimal(0);
        // Reversal swaps sides with absolute amounts (a mirrored entry) —
        // negating would create negative debits/credits, which are invalid.
        const side: 'DEBIT' | 'CREDIT' =
          input.reversal ? (l.side === 'DEBIT' ? 'CREDIT' : 'DEBIT') : l.side;
        return {
          accountCode: l.accountCode,
          debit: side === 'DEBIT' ? amount : new Prisma.Decimal(0),
          credit: side === 'CREDIT' ? amount : new Prisma.Decimal(0),
          description: l.memo ?? input.description,
          analytics: this.analyticsFor(l.measure, input.analytics),
        };
      });
      // ATOMIC LINK (Phase 7B stabilization): the journal and the event's
      // POSTED status (with journalEntryId) commit in ONE transaction — there
      // is no window where a journal exists but the event still reads FAILED.
      // The journal carries sourceEventId = event.id, DB-unique, so a
      // concurrent/replayed posting of the SAME event can never create a
      // second journal (P2002 → reconcile below); distinct events post freely.
      try {
        await this.prisma.$transaction(async (tx) => {
          const entry = await this.journal.post(tx as unknown as Prisma.TransactionClient, {
            companyId: input.companyId,
            entryDate: input.entryDate ?? new Date(),
            journalCode: 'OPERATIONAL',
            documentType: input.eventType,
            description:
              input.description ??
              `${input.eventType} ${input.sourceEntityType}:${input.sourceEntityId}`,
            createdBy: undefined,
            lines,
            sourceEventId: event.id,
          });
          await tx.accountingEvent.update({
            where: { id: event.id },
            data: { status: 'POSTED', journalEntryId: entry.id, postedAt: new Date(), error: null },
          });
        });
      } catch (postingError) {
        const isDuplicateSource =
          postingError instanceof Prisma.PrismaClientKnownRequestError &&
          postingError.code === 'P2002' &&
          JSON.stringify(postingError.meta ?? {}).includes('source_event_id');
        if (!isDuplicateSource) throw postingError;
        // RECONCILE: another transaction (concurrent instance or a replay)
        // already created THIS event's journal. Link it instead of failing.
        const existing = await this.prisma.journalEntry.findFirst({
          where: { companyId: input.companyId, sourceEventId: event.id },
          select: { id: true },
        });
        if (existing) {
          await this.prisma.accountingEvent.update({
            where: { id: event.id },
            data: { status: 'POSTED', journalEntryId: existing.id, postedAt: new Date(), error: null },
          });
          return;
        }
        throw postingError;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`event ${event.id} FAILED: ${message}`);
      await this.prisma.accountingEvent.update({
        where: { id: event.id },
        data: { status: 'FAILED', error: message },
      });
    }
  }

  async list(companyId: string, query: { page?: number; pageSize?: number; eventType?: AccountingEventType; status?: string }) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(Math.max(query.pageSize ?? 20, 1), 100);
    const where: Prisma.AccountingEventWhereInput = {
      companyId,
      ...(query.eventType ? { eventType: query.eventType } : {}),
      ...(query.status ? { status: query.status as 'POSTED' | 'FAILED' | 'SKIPPED' } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.accountingEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.accountingEvent.count({ where }),
    ]);
    return { items, total, page, pageSize };
  }

  /** Retry a FAILED event against its stored payload.
   *  Concurrency: retries of the SAME event serialize through an in-process
   *  gate (deployment is single-instance) — the second caller re-checks the
   *  status after the gate opens and returns the repaired result instead of
   *  posting a duplicate journal. The journalEntryId repair guard in emit()
   *  covers the crash window where the journal was posted but the status
   *  update failed. NOTE: pg_advisory_xact_lock via the shared PrismaClient
   *  was verified NOT to serialize concurrent interactive transactions on one
   *  client, so an in-process gate is the correct mechanism here. */
  private readonly retryGates = new Map<string, Promise<{ status: string; error: string | null }>>();

  async retry(companyId: string, eventId: string): Promise<{ status: string; error: string | null }> {
    const prev = this.retryGates.get(eventId) ?? Promise.resolve();
    const gate = prev
      .catch(() => undefined) // a failed prior retry must not poison the gate
      .then(() => this.doRetry(companyId, eventId));
    this.retryGates.set(eventId, gate);
    try {
      return await gate;
    } finally {
      if (this.retryGates.get(eventId) === gate) this.retryGates.delete(eventId);
    }
  }

  private async doRetry(
    companyId: string,
    eventId: string,
  ): Promise<{ status: string; error: string | null }> {
    const event = await this.prisma.accountingEvent.findFirst({
      where: { id: eventId, companyId },
    });
    if (!event) throw new ValidationError('ACCOUNTING_EVENT_NOT_FOUND', { eventId });
    if (event.status === 'POSTED') return { status: event.status, error: null };
    if (event.status === 'SKIPPED') return { status: event.status, error: event.error };
    const payload = event.payload as {
      measures: Partial<Record<PostingMeasure, string>>;
      analytics: { customerId?: string | null; supplierId?: string | null };
      reversal: boolean;
      entryDate?: string | null;
    } | null;
    const measures: Partial<Record<PostingMeasure, Prisma.Decimal>> = {};
    for (const [k, v] of Object.entries(payload?.measures ?? {})) {
      measures[k as PostingMeasure] = new Prisma.Decimal(v as string | number);
    }
    // measures/analytics/reversal AND the financial entryDate are all taken
    // from the stored payload — a retry reproduces the original posting.
    await this.emit({
      companyId,
      eventType: event.eventType,
      sourceEntityType: event.sourceEntityType,
      sourceEntityId: event.sourceEntityId,
      idempotencyKey: event.idempotencyKey,
      measures,
      analytics: payload?.analytics ?? {},
      reversal: payload?.reversal ?? false,
      entryDate: payload?.entryDate ? new Date(payload.entryDate) : undefined,
    });
    const fresh = await this.prisma.accountingEvent.findUniqueOrThrow({ where: { id: eventId } });
    return { status: fresh.status, error: fresh.error };
  }

  private analyticsFor(
    measure: PostingMeasure,
    analytics: EmitInput['analytics'],
  ): JournalLineInput['analytics'] {
    const out: NonNullable<JournalLineInput['analytics']> = [];
    if (analytics.customerId && (measure === 'RECEIVABLE' || measure === 'REVENUE')) {
      out.push({ dimensionType: 'CUSTOMER', dimensionId: analytics.customerId });
    }
    if (analytics.supplierId && (measure === 'PAYABLE' || measure === 'INVENTORY')) {
      out.push({ dimensionType: 'SUPPLIER', dimensionId: analytics.supplierId });
    }
    if (analytics.salespersonUserId && measure === 'REVENUE') {
      out.push({ dimensionType: 'SALESPERSON', dimensionId: analytics.salespersonUserId });
    }
    if (analytics.productVariantId && (measure === 'REVENUE' || measure === 'COGS' || measure === 'INVENTORY')) {
      out.push({ dimensionType: 'PRODUCT_VARIANT', dimensionId: analytics.productVariantId });
    }
    return out;
  }
}
