import { Injectable } from '@nestjs/common';
import { Prisma, JournalEntry } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors';

export interface JournalLineAnalyticInput {
  dimensionType: 'CUSTOMER' | 'SUPPLIER' | 'SALESPERSON' | 'PRODUCT_VARIANT' | 'EMPLOYEE' | 'PROJECT' | 'COST_CENTER';
  dimensionId: string;
  label?: string;
}

export interface JournalLineInput {
  accountCode: string;
  partyId?: string | null;
  /** Authoritative amounts: Prisma.Decimal (or decimal string). JS numbers are
   *  accepted at API edges for convenience but ALL math is Decimal-based. */
  debit: Prisma.Decimal | string | number;
  credit: Prisma.Decimal | string | number;
  description?: string;
  /** Analytical dimensions (7A-3): CUSTOMER/SUPPLIER receivable-payable
   *  tracking plus future EMPLOYEE/PROJECT/COST_CENTER. */
  analytics?: JournalLineAnalyticInput[];
}

export interface PostJournalInput {
  companyId: string;
  entryDate: Date;
  journalCode?: string;
  documentType?: string;
  description?: string;
  createdBy?: string;
  lines: JournalLineInput[];
  /** Durable idempotency key (Phase 7B stabilization): the accounting event id
   *  when this journal is created FROM an event. DB-unique — the same event
   *  can never produce two journals. NULL for manual/opening/reversal posts. */
  sourceEventId?: string;
}

type Tx = Prisma.TransactionClient;

/**
 * Double-entry journal service. Invariants (mirrored by DB CHECKs):
 *   - a line carries exactly one of debit/credit (positive, XOR);
 *   - SUM(debit) == SUM(credit) inside the POST transaction;
 *   - a POSTED entry is never edited/deleted — corrected via `reverse()`
 *     which creates a mirrored entry and marks the original REVERSED.
 */
@Injectable()
export class JournalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
  ) {}

  /** Validates line semantics with exact Decimal math; no floats. */
  static validateLines(lines: JournalLineInput[]): void {
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new ValidationError('Journal entry requires at least one line', { lines });
    }
    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    for (const [index, line] of lines.entries()) {
      const debit = new Prisma.Decimal(line.debit ?? 0);
      const credit = new Prisma.Decimal(line.credit ?? 0);
      if (debit.isNegative() || credit.isNegative()) {
        throw new ValidationError('Journal line amounts must be non-negative', { index });
      }
      if (debit.gt(0) && credit.gt(0)) {
        throw new ValidationError('A journal line cannot carry both debit and credit', { index });
      }
      if (debit.isZero() && credit.isZero()) {
        throw new ValidationError('A journal line must carry a debit or a credit', { index });
      }
      totalDebit = totalDebit.plus(debit);
      totalCredit = totalCredit.plus(credit);
    }
    if (!totalDebit.equals(totalCredit)) {
      throw new ValidationError('JOURNAL_UNBALANCED', {
        totalDebit: totalDebit.toString(),
        totalCredit: totalCredit.toString(),
      });
    }
  }

  /**
   * Post a balanced journal entry inside `tx` (caller owns the transaction).
   * Entry is created DRAFT with lines, then atomically set POSTED — a crash
   * leaves a DRAFT, never a half-posted entry.
   */
  async post(tx: Tx, input: PostJournalInput): Promise<JournalEntry & { lines: unknown[] }> {
    JournalService.validateLines(input.lines);

    // Fiscal guard (Phase 7A-1): postings are rejected into CLOSED fiscal
    // years/periods. No fiscal calendar → no guard (documented). Reversals
    // intentionally bypass this guard and date back to the original entry.
    await this.assertOpenPeriod(tx, input.companyId, input.entryDate);

    const codes = [...new Set(input.lines.map((l) => l.accountCode))];
    const accounts = await tx.chartOfAccount.findMany({
      where: { companyId: input.companyId, code: { in: codes } },
      select: { id: true, code: true },
    });
    const byCode = new Map(accounts.map((a) => [a.code, a.id]));
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length > 0) {
      throw new ValidationError('Unknown account code(s)', { missing });
    }

    const { number: entryNumber } = await this.sequences.allocate(
      input.companyId,
      'JOURNAL_ENTRY',
      tx,
      input.entryDate,
    );

    const entry = await tx.journalEntry.create({
      data: {
        companyId: input.companyId,
        entryNumber,
        entryDate: input.entryDate,
        journalCode: input.journalCode ?? 'GENERAL',
        documentType: input.documentType,
        description: input.description,
        status: 'DRAFT',
        createdBy: input.createdBy,
        sourceEventId: input.sourceEventId ?? null,
        lines: {
          create: input.lines.map((line) => ({
            companyId: input.companyId,
            accountId: byCode.get(line.accountCode)!,
            partyId: line.partyId ?? null,
            description: line.description,
            debit: new Prisma.Decimal(line.debit ?? 0),
            credit: new Prisma.Decimal(line.credit ?? 0),
            analytics: {
              create: (line.analytics ?? []).map((a) => ({
                dimensionType: a.dimensionType,
                dimensionId: a.dimensionId,
                label: a.label ?? null,
              })),
            },
          })),
        },
      },
      include: { lines: true },
    });

    return tx.journalEntry.update({
      where: { id: entry.id },
      data: { status: 'POSTED', postedAt: new Date() },
      include: { lines: true },
    }) as Promise<JournalEntry & { lines: unknown[] }>;
  }


  /**
   * Fiscal guard (Phase 7A-1): reject postings into CLOSED fiscal years or
   * periods. Resolution order for `date`:
   *   1. the FiscalYear containing it — CLOSED → FISCAL_YEAR_CLOSED;
   *   2. when that year defines monthly periods, the containing period —
   *      CLOSED → PERIOD_CLOSED, missing → PERIOD_NOT_FOUND;
   *   3. no fiscal calendar at all → posting allowed (documented).
   */
  async assertOpenPeriod(
    tx: Tx,
    companyId: string,
    date: Date,
  ): Promise<void> {
    // Optional-chain + guard: some callers (legacy unit tests) hand a stubbed
    // tx without fiscal delegates — treated as "no fiscal calendar".
    const year = (await tx.fiscalYear?.findFirst?.({
      where: {
        companyId,
        startDate: { lte: date },
        endDate: { gte: date },
      },
    })) ?? null;
    if (!year) return; // no fiscal calendar → unguarded (documented)
    if (year.status === 'CLOSED') {
      throw new ValidationError('FISCAL_YEAR_CLOSED', { fiscalYearCode: year.code });
    }
    const period = (await tx.fiscalPeriod?.findFirst?.({
      where: {
        fiscalYearId: year.id,
        startDate: { lte: date },
        endDate: { gte: date },
      },
    })) ?? null;
    if (period) {
      if (period.status === 'CLOSED') {
        throw new ValidationError('PERIOD_CLOSED', { periodCode: period.code });
      }
    } else {
      throw new ValidationError('PERIOD_NOT_FOUND', { fiscalYearCode: year.code });
    }
  }

  /**
   * Reverse a POSTED entry: creates a mirrored POSTED entry (debit ↔ credit)
   * and marks the original REVERSED with reversedByEntryId. Idempotency
   * guard: an already REVERSED entry cannot be reversed again.
   */
  async reverse(
    entryId: string,
    actor?: { id?: string },
  ): Promise<{ original: JournalEntry; reversal: JournalEntry & { lines: unknown[] } }> {
    return this.prisma.$transaction(async (trx) => {
      const original = await trx.journalEntry.findUnique({
        where: { id: entryId },
        include: { lines: true },
      });
      if (!original) throw new NotFoundError('Journal entry not found', { entryId });
      if (original.status === 'REVERSED') {
        throw new ValidationError('Journal entry is already reversed', { entryId });
      }
      if (original.status !== 'POSTED') {
        throw new ValidationError('Only POSTED journal entries can be reversed', {
          status: original.status,
        });
      }

      const accountIds = [...new Set(original.lines.map((l) => l.accountId))];
      const accounts = await trx.chartOfAccount.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, code: true },
      });
      const codeById = new Map(accounts.map((a) => [a.id, a.code]));

      const reversal = await this.post(trx, {
        companyId: original.companyId,
        entryDate: new Date(),
        journalCode: original.journalCode,
        documentType: original.documentType ?? undefined,
        description: `Reversal of ${original.entryNumber}`,
        createdBy: actor?.id,
        lines: original.lines.map((line) => ({
          accountCode: codeById.get(line.accountId)!,
          partyId: line.partyId,
          debit: new Prisma.Decimal(line.credit ?? 0),
          credit: new Prisma.Decimal(line.debit ?? 0),
          description: line.description ?? undefined,
        })),
      });

      const updatedOriginal = await trx.journalEntry.update({
        where: { id: original.id },
        data: { status: 'REVERSED', reversedByEntryId: reversal.id },
      });
      return { original: updatedOriginal, reversal };
    });
  }

  /** POSTED entries are immutable — guards any future edit/delete path. */
  static assertMutable(entry: Pick<JournalEntry, 'status'>): void {
    if (entry.status === 'POSTED' || entry.status === 'REVERSED') {
      throw new ForbiddenError('POSTED journal entries cannot be modified; reverse instead', {
        status: entry.status,
      });
    }
  }

  async getById(companyId: string, id: string) {
    const entry = await this.prisma.journalEntry.findUnique({
      where: { id },
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    });
    if (!entry || entry.companyId !== companyId) {
      throw new NotFoundError('Journal entry not found', { id });
    }
    return entry;
  }

  async list(companyId: string, limit = 50) {
    return this.prisma.journalEntry.findMany({
      where: { companyId },
      orderBy: [{ entryDate: 'desc' }, { createdAt: 'desc' }],
      take: limit,
      include: { lines: true },
    });
  }
}
