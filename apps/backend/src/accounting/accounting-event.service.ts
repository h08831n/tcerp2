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
        payload: { measures: input.measures, analytics: input.analytics, reversal: input.reversal ?? false } as Prisma.InputJsonValue,
        status: 'FAILED',
        idempotencyKey: input.idempotencyKey,
      },
      update: {},
    });
    if (event.status === 'POSTED') return; // idempotent
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
          debit: side === 'DEBIT' ? amount.toNumber() : 0,
          credit: side === 'CREDIT' ? amount.toNumber() : 0,
          description: l.memo ?? input.description,
          analytics: this.analyticsFor(l.measure, input.analytics),
        };
      });
      const entry = await this.journal.post(this.prisma as unknown as Prisma.TransactionClient, {
        companyId: input.companyId,
        entryDate: input.entryDate ?? new Date(),
        journalCode: 'OPERATIONAL',
        documentType: input.eventType,
        description: input.description ?? `${input.eventType} ${input.sourceEntityType}:${input.sourceEntityId}`,
        createdBy: undefined,
        lines,
      });
      await this.prisma.accountingEvent.update({
        where: { id: event.id },
        data: { status: 'POSTED', journalEntryId: entry.id, postedAt: new Date(), error: null },
      });
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

  /** Retry a FAILED event against its stored payload. */
  async retry(companyId: string, eventId: string): Promise<{ status: string; error: string | null }> {
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
    } | null;
    const measures: Partial<Record<PostingMeasure, Prisma.Decimal>> = {};
    for (const [k, v] of Object.entries(payload?.measures ?? {})) {
      measures[k as PostingMeasure] = new Prisma.Decimal(v as string);
    }
    await this.emit({
      companyId,
      eventType: event.eventType,
      sourceEntityType: event.sourceEntityType,
      sourceEntityId: event.sourceEntityId,
      idempotencyKey: event.idempotencyKey,
      measures,
      analytics: payload?.analytics ?? {},
      reversal: payload?.reversal ?? false,
    });
    const fresh = await this.prisma.accountingEvent.findUniqueOrThrow({ where: { id: eventId } });
    return { status: fresh.status, error: fresh.error };
  }

  private analyticsFor(
    measure: PostingMeasure,
    analytics: EmitInput['analytics'],
  ): JournalLineInput['analytics'] {
    const out: NonNullable<JournalLineInput['analytics']> = [];
    if (measure === 'RECEIVABLE' && analytics.customerId) {
      out.push({ dimensionType: 'CUSTOMER', dimensionId: analytics.customerId });
    }
    if (measure === 'PAYABLE' && analytics.supplierId) {
      out.push({ dimensionType: 'SUPPLIER', dimensionId: analytics.supplierId });
    }
    return out;
  }
}
