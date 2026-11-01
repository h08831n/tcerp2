import { Injectable } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JournalService } from './journal.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { SequencesService } from '../sequences/sequences.service';
import { AuditService } from '../audit/audit.service';

type Tx = Prisma.TransactionClient;

export interface OpeningBalanceRowInput {
  accountCode: string;
  partyId?: string | null;
  partyName?: string | null;
  productVariantId?: string | null;
  quantity?: string | number | null;
  unitCost?: string | number | null;
  debit?: string | number | null;
  credit?: string | number | null;
  note?: string | null;
}

/**
 * Opening balances (docs/06 §6): staged rows, then ONE balanced OPENING
 * journal entry per company. The generated entry keeps the trial balance
 * balanced from day one; rows flip to GENERATED (immutable history).
 */
@Injectable()
export class OpeningBalanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
    private readonly sequences: SequencesService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Stage opening rows. P0-2: rows are bound to a FISCAL YEAR at stage time.
   * R-4 (review of 96f9af0): WITHOUT an explicit fiscalYearId the rows are
   * auto-bound to the fiscal year containing TODAY (API-backward-compatible,
   * and never trapped as null rows that no annual generate can consume);
   * when the company has NO fiscal calendar they stay null (legacy
   * single-batch path). An explicit fiscalYearId must belong to this
   * company and be OPEN.
   */
  async stage(
    companyId: string,
    rows: OpeningBalanceRowInput[],
    actor: { id: string; username: string },
    fiscalYearId?: string,
  ) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ValidationError('OPENING_ROWS_REQUIRED');
    }
    let fiscalYear: { id: string; status: string } | null = null;
    if (fiscalYearId !== undefined) {
      fiscalYear = await this.prisma.fiscalYear.findFirst({
        where: { id: fiscalYearId, companyId },
        select: { id: true, status: true },
      });
      if (!fiscalYear) throw new ValidationError('FISCAL_YEAR_NOT_FOUND');
      if (fiscalYear.status === 'CLOSED') throw new ValidationError('FISCAL_YEAR_CLOSED');
    } else {
      // R3-2: auto-bind to the current fiscal year when a calendar exists.
      // A calendar WITHOUT an open year containing today is an EXPLICIT
      // error — silently creating fiscalYearId=null rows that no annual
      // generate can consume is exactly the trap this design removes.
      // The legacy null-batch stays available ONLY for companies with NO
      // fiscal calendar at all.
      const today = new Date();
      fiscalYear = await this.prisma.fiscalYear.findFirst({
        where: { companyId, startDate: { lte: today }, endDate: { gte: today }, status: { not: 'CLOSED' } },
        select: { id: true, status: true },
      });
      if (!fiscalYear) {
        const calendarExists = await this.prisma.fiscalYear.count({ where: { companyId } });
        if (calendarExists > 0) throw new ValidationError('OPENING_FISCAL_YEAR_REQUIRED', { today });
      }
    }
    if (fiscalYear) {
      // R3-6: staging into a year that already carries a POSTED OPENING
      // document would create rows no generate can ever consume.
      await OpeningBalanceService.assertNoOpeningDoc(this.prisma, companyId, fiscalYear.id);
    }
    const accounts = await this.prisma.chartOfAccount.findMany({
      where: { companyId },
      select: { code: true, type: true },
    });
    const normalSideOf = (type: string) => (type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT');
    const byCode = new Map(accounts.map((a) => [a.code, { ...a, normalSide: normalSideOf(a.type) }]));

    return this.prisma.$transaction(async (tx: Tx) => {
      const created: string[] = [];
      let totalDebit = new Prisma.Decimal(0);
      let totalCredit = new Prisma.Decimal(0);
      for (const [index, row] of rows.entries()) {
        const account = byCode.get(row.accountCode);
        if (!account) {
          throw new ValidationError('ACCOUNT_NOT_FOUND', { index, accountCode: row.accountCode });
        }
        const debit = new Prisma.Decimal(row.debit ?? 0);
        const credit = new Prisma.Decimal(row.credit ?? 0);
        if (debit.lt(0) || credit.lt(0)) throw new ValidationError('OPENING_AMOUNT_NEGATIVE', { index });
        if (debit.gt(0) && credit.gt(0)) {
          throw new ValidationError('OPENING_BOTH_SIDES', { index });
        }
        if (debit.isZero() && credit.isZero()) {
          throw new ValidationError('OPENING_AMOUNT_REQUIRED', { index });
        }
        // Party rows: the row's normal side must match the account side so the
        // analytic balance direction is unambiguous.
        if (row.partyId) {
          const normalDebit = account.normalSide === 'DEBIT';
          if (normalDebit && credit.gt(0)) throw new ValidationError('OPENING_SIDE_MISMATCH', { index });
          if (!normalDebit && debit.gt(0)) throw new ValidationError('OPENING_SIDE_MISMATCH', { index });
        }
        // BUG-09: every staged reference must belong to THIS company — a
        // cross-company party/variant id must be rejected outright so no
        // inter-company relation or disclosure can enter an accounting doc.
        if (row.partyId) {
          const party = await tx.party.findFirst({
            where: { id: row.partyId, companyId },
            select: { id: true },
          });
          if (!party) throw new ValidationError('OPENING_PARTY_NOT_IN_COMPANY', { index });
        }
        if (row.productVariantId) {
          const variant = await tx.productVariant.findFirst({
            where: { id: row.productVariantId, companyId },
            select: { id: true },
          });
          if (!variant) throw new ValidationError('OPENING_VARIANT_NOT_IN_COMPANY', { index });
        }
        const createdRow = await tx.openingBalanceEntry.create({
          data: {
            companyId,
            fiscalYearId: fiscalYear?.id ?? null,
            accountCode: row.accountCode,
            partyId: row.partyId ?? null,
            partyName: row.partyName ?? null,
            productVariantId: row.productVariantId ?? null,
            quantity: row.quantity != null ? new Prisma.Decimal(row.quantity) : null,
            unitCost: row.unitCost != null ? new Prisma.Decimal(row.unitCost) : null,
            debit,
            credit,
            status: 'STAGED',
            note: row.note ?? null,
            createdBy: actor.id,
          },
        });
        created.push(createdRow.id);
        totalDebit = totalDebit.plus(debit);
        totalCredit = totalCredit.plus(credit);
      }
      await this.auditService.recordTx(tx, {
        entityType: 'opening_balance',
        entityId: created[0],
        action: 'IMPORT',
        companyId,
        actor,
        newValues: { rows: created.length, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString() },
      });
      return { staged: created.length, totalDebit: totalDebit.toString(), totalCredit: totalCredit.toString() };
    });
  }

  /**
   * Generate ONE balanced OPENING journal entry from the STAGED rows bound
   * to the TARGET fiscal year — explicit `fiscalYearId`, else the fiscal
   * year containing `entryDate`, else the legacy company-wide batch
   * (fiscalYearId=null rows, no calendar). Rows staged for OTHER years (or
   * unassigned rows while a calendar exists) are NEVER consumed — no
   * cross-year mixing (P0-2). BUG-07: the uniqueness scope is the fiscal
   * year of the entry; a duplicate within the SAME fiscal year is rejected.
   */
  async generate(
    companyId: string,
    actor: { id: string; username: string },
    entryDate?: Date,
    fiscalYearId?: string,
  ) {
    const date = entryDate ?? new Date();
    // R3-5: fiscal years are CALENDAR dates (db DATE = midnight) while the
    // entry date is a TIMESTAMP — the LAST calendar day belongs to the year
    // up to 23:59:59.999, not only to its midnight instant.
    const endOfDayExclusive = (d: Date): number => d.getTime() + 86_400_000;
    let fiscalYear: { id: string; startDate: Date; endDate: Date; status: string } | null;
    if (fiscalYearId !== undefined) {
      // R-3: an explicit FY must exist, be OPEN, and CONTAIN the entry date —
      // an out-of-year date would post an OPENING entry outside the year the
      // uniqueness scope protects.
      const explicit = await this.prisma.fiscalYear.findFirst({
        where: { id: fiscalYearId, companyId },
        select: { id: true, startDate: true, endDate: true, status: true },
      });
      if (!explicit) throw new ValidationError('FISCAL_YEAR_NOT_FOUND');
      if (explicit.status === 'CLOSED') throw new ValidationError('FISCAL_YEAR_CLOSED');
      if (
        date.getTime() < explicit.startDate.getTime() ||
        date.getTime() >= endOfDayExclusive(explicit.endDate)
      ) {
        // Request well-formedness FIRST — an out-of-year date is reported
        // even when the year already carries an OPENING document.
        throw new ValidationError('OPENING_DATE_OUTSIDE_FISCAL_YEAR', {
          entryDate: date.toISOString(),
          fiscalYearId,
        });
      }
      fiscalYear = explicit;
    } else {
      // Calendar-day comparison for the implicit path as well.
      const dayStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      fiscalYear = await this.prisma.fiscalYear.findFirst({
        where: { companyId, startDate: { lte: dayStart }, endDate: { gte: dayStart } },
        select: { id: true, startDate: true, endDate: true, status: true },
      });
      if (fiscalYear?.status === 'CLOSED') throw new ValidationError('FISCAL_YEAR_CLOSED');
    }
    // Uniqueness FIRST (R3-review follow-up): an already-generated year must
    // report OPENING_ALREADY_GENERATED, not a misleading NO_STAGED rows error.
    if (fiscalYear) {
      const existing = await this.prisma.journalEntry.findFirst({
        where: {
          companyId,
          documentType: 'OPENING',
          status: 'POSTED',
          entryDate: {
            gte: fiscalYear.startDate,
            lt: new Date(endOfDayExclusive(fiscalYear.endDate)),
          },
        },
        select: { id: true, entryNumber: true },
      });
      if (existing) {
        throw new ConflictError(
          'OPENING_ALREADY_GENERATED_FOR_FISCAL_YEAR',
          { entryNumber: existing.entryNumber },
        );
      }
    }
    const staged = await this.prisma.openingBalanceEntry.findMany({
      where: { companyId, status: 'STAGED', fiscalYearId: fiscalYear?.id ?? null },
    });
    if (staged.length === 0) throw new ValidationError('NO_STAGED_OPENING_ROWS');

    const result = await this.prisma.$transaction(async (tx: Tx) => {
      // Concurrency control: serialize generate() per company so two racing
      // requests cannot both pass the pre-check and post twin OPENING entries.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${companyId}))`;
      const raced = await tx.journalEntry.findFirst({
        where: {
          companyId,
          documentType: 'OPENING',
          status: 'POSTED',
          ...(fiscalYear
            ? { entryDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate } }
            : {}),
        },
        select: { id: true, entryNumber: true },
      });
      if (raced) {
        throw new ConflictError(
          fiscalYear ? 'OPENING_ALREADY_GENERATED_FOR_FISCAL_YEAR' : 'OPENING_ALREADY_GENERATED',
          { entryNumber: raced.entryNumber },
        );
      }
      // Build ALL lines FIRST: staged rows + OPENING_EQUITY residual, then post
      // ONE balanced entry (integrity gate #11 — no post-then-patch).
      const lines: Array<{
        accountCode: string;
        partyId?: string;
        debit: Prisma.Decimal;
        credit: Prisma.Decimal;
        description?: string;
      }> = staged.map((row) => ({
        accountCode: row.accountCode,
        ...(row.partyId ? { partyId: row.partyId } : {}),
        debit: new Prisma.Decimal(row.debit),
        credit: new Prisma.Decimal(row.credit),
        description: row.partyName ? `افتتاحیه — ${row.partyName}` : row.note ?? 'افتتاحیه',
      }));
      let stagedDebit = new Prisma.Decimal(0);
      let stagedCredit = new Prisma.Decimal(0);
      for (const l of lines) {
        stagedDebit = stagedDebit.plus(l.debit);
        stagedCredit = stagedCredit.plus(l.credit);
      }
      const diff = stagedDebit.minus(stagedCredit);
      let balancingAmount = new Prisma.Decimal(0);
      if (!diff.isZero()) {
        const equity = await tx.chartOfAccount.findFirst({
          where: { companyId, code: 'OPENING_EQUITY' },
        });
        if (!equity) throw new ValidationError('OPENING_EQUITY_ACCOUNT_MISSING');
        balancingAmount = diff.abs();
        // debit > credit → CREDIT the difference; credit > debit → DEBIT it
        lines.push({
          accountCode: 'OPENING_EQUITY',
          debit: diff.lt(0) ? balancingAmount : new Prisma.Decimal(0),
          credit: diff.gt(0) ? balancingAmount : new Prisma.Decimal(0),
          description: 'مانده افتتاحیه (سرمایه)',
        });
      }
      const entry = await this.journal.post(tx, {
        companyId,
        entryDate: date,
        journalCode: 'OPENING',
        documentType: 'OPENING',
        description: 'سند افتتاحیه',
        createdBy: actor.id,
        lines,
      });

      await tx.openingBalanceEntry.updateMany({
        where: { id: { in: staged.map((r) => r.id) } },
        data: { status: 'GENERATED', journalEntryId: entry.id, fiscalYearId: fiscalYear?.id ?? null },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'opening_balance',
        entityId: entry.id,
        action: 'GENERATE',
        companyId,
        actor,
        newValues: {
          entryNumber: entry.entryNumber,
          rows: staged.length,
          stagedDebit: stagedDebit.toString(),
          stagedCredit: stagedCredit.toString(),
          balancingAmount: balancingAmount.toString(),
        },
      });
      return entry;
    });
    return result;
  }

  async list(companyId: string) {
    return this.prisma.openingBalanceEntry.findMany({
      where: { companyId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
  }

  /**
   * R-4: safely assign ALL unassigned (fiscalYearId=null) STAGED rows of the
   * company to a validated OPEN fiscal year — the migration path for rows
   * staged by older versions. Rows are UPDATED, never deleted; audited.
   */
  async assignTo(
    companyId: string,
    fiscalYearId: string,
    actor: { id: string; username: string },
    opts: { rowIds?: string[]; preview?: boolean } = {},
  ): Promise<number | { count: number; rows: Array<{ id: string; accountCode: string; debit: unknown; credit: unknown }> }> {
    const fiscalYear = await this.prisma.fiscalYear.findFirst({
      where: { id: fiscalYearId, companyId },
      select: { id: true, status: true },
    });
    if (!fiscalYear) throw new ValidationError('FISCAL_YEAR_NOT_FOUND');
    if (fiscalYear.status === 'CLOSED') throw new ValidationError('FISCAL_YEAR_CLOSED');
    // R3-6: never assign into a year that already has its OPENING document.
    await OpeningBalanceService.assertNoOpeningDoc(this.prisma, companyId, fiscalYear.id);

    // Candidate pool: unassigned STAGED rows of this company, optionally
    // restricted to an explicit selection (R3-1: the operation is SELECTIVE).
    const pool = await this.prisma.openingBalanceEntry.findMany({
      where: {
        companyId,
        status: 'STAGED',
        fiscalYearId: null,
        ...(opts.rowIds ? { id: { in: opts.rowIds } } : {}),
      },
      select: { id: true, accountCode: true, debit: true, credit: true },
      orderBy: { createdAt: 'asc' },
    });
    if (opts.rowIds) {
      // Every explicitly requested row must exist in the assignable pool.
      const poolIds = new Set(pool.map((r) => r.id));
      const missing = opts.rowIds.filter((id) => !poolIds.has(id));
      if (missing.length > 0) {
        throw new ValidationError('OPENING_ROW_NOT_ASSIGNABLE', { missing });
      }
    }
    if (opts.preview) {
      // Preview mutates NOTHING and writes NO audit row.
      return { count: pool.length, rows: pool };
    }
    if (pool.length === 0) return 0;
    const result = await this.prisma.$transaction(async (tx: Tx) => {
      // CAS: rows may only move while still STAGED and unassigned.
      const updated = await tx.openingBalanceEntry.updateMany({
        where: { id: { in: pool.map((r) => r.id) }, status: 'STAGED', fiscalYearId: null },
        data: { fiscalYearId },
      });
      if (updated.count === 0) return 0;
      // R3-1: row-LEVEL audit — the exact id list that moved.
      await this.auditService.recordTx(tx, {
        entityType: 'opening_balance',
        entityId: pool[0].id,
        action: 'ASSIGN',
        companyId,
        actor,
        oldValues: { rows: pool.length, fiscalYearId: null },
        newValues: { rows: updated.count, rowIds: pool.map((r) => r.id), fiscalYearId },
      });
      return updated.count;
    });
    return result;
  }

  /** R3-6 guard: a POSTED OPENING document inside the fiscal year's window
   *  (calendar-day inclusive) blocks further staging/assignment. */
  private static async assertNoOpeningDoc(
    client: PrismaService | Tx,
    companyId: string,
    fiscalYearId: string,
  ): Promise<void> {
    const fy = await client.fiscalYear.findUniqueOrThrow({
      where: { id: fiscalYearId },
      select: { startDate: true, endDate: true },
    });
    const existing = await client.journalEntry.findFirst({
      where: {
        companyId,
        documentType: 'OPENING',
        status: 'POSTED',
        entryDate: { gte: fy.startDate, lt: new Date(fy.endDate.getTime() + 86_400_000) },
      },
      select: { entryNumber: true },
    });
    if (existing) {
      throw new ConflictError('OPENING_FISCAL_YEAR_ALREADY_GENERATED', {
        entryNumber: existing.entryNumber,
      });
    }
  }

  /** Ledger-side validation helper used by tests/reports: staged balance check. */
  assertStagedBalanced(rows: OpeningBalanceRowInput[]): void {
    const debit = rows.reduce((s, r) => s.plus(new Prisma.Decimal(r.debit ?? 0)), new Prisma.Decimal(0));
    const credit = rows.reduce((s, r) => s.plus(new Prisma.Decimal(r.credit ?? 0)), new Prisma.Decimal(0));
    if (!debit.equals(credit)) {
      throw new ValidationError('OPENING_IMPORT_UNBALANCED', {
        totalDebit: debit.toString(),
        totalCredit: credit.toString(),
      });
    }
  }

  static for(prisma: PrismaClient): OpeningBalanceService {
    return new OpeningBalanceService(
      prisma as unknown as PrismaService,
      new JournalService(prisma as unknown as PrismaService, new SequencesService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService))),
      new SequencesService(prisma as unknown as PrismaService, new AuditService(prisma as unknown as PrismaService)),
      new AuditService(prisma as unknown as PrismaService),
    );
  }
}

// Re-exported so tests can import without circulars.
export { NotFoundError };
