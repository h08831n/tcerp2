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

    // P1-3 (review of 80502ae): every analytic reference must belong to THIS
    // company — a cross-company partyId/dimensionId must be rejected before
    // any row is written (no inter-company relation, no disclosure). Batched
    // lookups keep this O(1) queries per entity kind, not per line. Direct
    // line partyIds and analytics dimensionIds report DISTINCT error codes.
    const directPartyIds = new Set<string>();
    const analyticPartyIds = new Set<string>();
    const refVariantIds = new Set<string>();
    const refUserIds = new Set<string>();
    for (const line of input.lines) {
      if (line.partyId) directPartyIds.add(line.partyId);
      for (const a of line.analytics ?? []) {
        if (a.dimensionType === 'CUSTOMER' || a.dimensionType === 'SUPPLIER') analyticPartyIds.add(a.dimensionId);
        else if (a.dimensionType === 'PRODUCT_VARIANT') refVariantIds.add(a.dimensionId);
        else if (a.dimensionType === 'SALESPERSON' || a.dimensionType === 'EMPLOYEE') refUserIds.add(a.dimensionId);
        // PROJECT / COST_CENTER have no owning table yet — label-level only.
      }
    }
    const assertAllFound = (found: Set<string>, ids: Set<string>, code: string) => {
      const notFound = [...ids].filter((id) => !found.has(id));
      if (notFound.length > 0) throw new ValidationError(code, { notFound });
    };
    if (directPartyIds.size > 0) {
      const found = await tx.party.findMany({
        where: { id: { in: [...directPartyIds] }, companyId: input.companyId },
        select: { id: true },
      });
      assertAllFound(new Set(found.map((p) => p.id)), directPartyIds, 'JOURNAL_PARTY_NOT_IN_COMPANY');
    }
    if (analyticPartyIds.size > 0) {
      const found = await tx.party.findMany({
        where: { id: { in: [...analyticPartyIds] }, companyId: input.companyId },
        select: { id: true },
      });
      assertAllFound(new Set(found.map((p) => p.id)), analyticPartyIds, 'JOURNAL_ANALYTIC_NOT_IN_COMPANY');
    }
    if (refVariantIds.size > 0) {
      const found = await tx.productVariant.findMany({
        where: { id: { in: [...refVariantIds] }, companyId: input.companyId },
        select: { id: true },
      });
      assertAllFound(new Set(found.map((v) => v.id)), refVariantIds, 'JOURNAL_ANALYTIC_NOT_IN_COMPANY');
    }
    if (refUserIds.size > 0) {
      const found = await tx.userCompany.findMany({
        where: { companyId: input.companyId, userId: { in: [...refUserIds] } },
        select: { userId: true },
      });
      assertAllFound(new Set(found.map((u) => u.userId)), refUserIds, 'JOURNAL_ANALYTIC_NOT_IN_COMPANY');
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
    // R3-5: fiscal years/periods are CALENDAR dates (db DATE = midnight) —
    // the comparison uses the entry's calendar DAY, so a timestamp at
    // 12:00 on the LAST day of a year/period still belongs to it.
    // R5-P1 TIMEZONE POLICY (documented): the calendar day is derived from
    // the entry timestamp's UTC components. An entry at 2026-03-20T20:30Z
    // (= 2026-03-21 00:00 in Asia/Tehran, +03:30) is attributed to March 20
    // by this policy. Switching the anchor to Asia/Tehran would shift every
    // fiscal boundary and requires an explicit owner decision — recorded as
    // an open item in the merge-readiness report, NOT silently changed.
    const calendarDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
    // Optional-chain + guard: some callers (legacy unit tests) hand a stubbed
    // tx without fiscal delegates — treated as "no fiscal calendar".
    // Deterministic + overlap-tolerant year resolution: production calendars
    // never overlap (single candidate → identical behavior), but overlapping
    // calendars must resolve to whichever candidate can LEGALLY accept the
    // posting (open year + open period) instead of an arbitrary heap-order
    // pick — the previous findFirst flipped between OPEN and CLOSED years
    // run-to-run (observed as flaky PERIOD_CLOSED).
    const candidates = (await tx.fiscalYear?.findMany?.({
      where: {
        companyId,
        startDate: { lte: calendarDay },
        endDate: { gte: calendarDay },
      },
      orderBy: { startDate: 'desc' },
      select: { id: true, code: true, status: true },
    })) ?? [];
    let year: { id: string; code: string; status: string } | null = null;
    let period: { code: string; status: string } | null = null;
    if (candidates.length > 0) {
      const periods = (await tx.fiscalPeriod?.findMany?.({
        where: {
          fiscalYearId: { in: candidates.map((c) => c.id) },
          startDate: { lte: calendarDay },
          endDate: { gte: calendarDay },
        },
      })) ?? [];
      for (const candidate of candidates) {
        const match = periods.find((p) => p.fiscalYearId === candidate.id) ?? null;
        if (candidate.status !== 'CLOSED' && match && match.status !== 'CLOSED') {
          year = candidate;
          period = match;
          break;
        }
      }
      if (!year) {
        // No candidate can accept the posting — report the FIRST (deterministic)
        // candidate's state via the original checks below.
        year = candidates[0];
        period = periods.find((p) => p.fiscalYearId === year!.id) ?? null;
      }
    }
    if (!year) {
      // R5-P1 policy: a company with NO fiscal calendar at all posts
      // unguarded (legacy, documented). A company WITH a calendar must NOT
      // post a document dated outside every year window silently — that is
      // an explicit configuration/request error.
      const calendarExists =
        (await tx.fiscalYear?.count?.({ where: { companyId } })) ?? 0;
      if (calendarExists > 0) {
        throw new ValidationError('FISCAL_YEAR_NOT_FOUND_FOR_DATE', {
          date: date.toISOString(),
        });
      }
      return; // truly no calendar → legacy unguarded (documented)
    }
    if (year.status === 'CLOSED') {
      throw new ValidationError('FISCAL_YEAR_CLOSED', { fiscalYearCode: year.code });
    }
    if (period) {
      if (period.status === 'CLOSED') {
        throw new ValidationError('PERIOD_CLOSED', { periodCode: period.code });
      }
    } else {
      throw new ValidationError('PERIOD_NOT_FOUND', { fiscalYearCode: year?.code ?? 'unknown' });
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
    companyId?: string,
  ): Promise<{ original: JournalEntry; reversal: JournalEntry & { lines: unknown[] } }> {
    return this.prisma.$transaction(async (trx) => {
      const original = await trx.journalEntry.findUnique({
        where: { id: entryId },
        include: { lines: { include: { analytics: true } } },
      });
      // Company scope: a companyId-aware caller (every future HTTP route)
      // must pass it; a foreign entry is indistinguishable from a missing
      // one (404 — never 403, no existence leak across companies).
      if (companyId && original && original.companyId !== companyId) {
        throw new NotFoundError('Journal entry not found', { entryId });
      }
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
          // BUG-13: analytic dimensions must survive the reversal — a
          // dimension-filtered report must net the original against its
          // reversal to zero (partyId was carried; analytics were dropped).
          analytics: (line.analytics ?? []).map((a) => ({
            dimensionType: a.dimensionType,
            dimensionId: a.dimensionId,
            label: a.label ?? undefined,
          })),
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
