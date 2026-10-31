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

  async stage(
    companyId: string,
    rows: OpeningBalanceRowInput[],
    actor: { id: string; username: string },
  ) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new ValidationError('OPENING_ROWS_REQUIRED');
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
   * Generate ONE balanced OPENING journal entry from all STAGED rows.
   * BUG-07: the uniqueness scope is the FISCAL YEAR of the entry date, not
   * the company — FY 1404 may carry an opening entry while FY 1405 generates
   * its own independently; a duplicate within the SAME fiscal year is
   * rejected. Without any fiscal calendar the legacy company-wide rule
   * applies (documented fallback). Staged rows are a batch — they all flow
   * into the generated entry and are stamped with the resolved fiscal year.
   */
  async generate(
    companyId: string,
    actor: { id: string; username: string },
    entryDate?: Date,
  ) {
    const staged = await this.prisma.openingBalanceEntry.findMany({
      where: { companyId, status: 'STAGED' },
    });
    if (staged.length === 0) throw new ValidationError('NO_STAGED_OPENING_ROWS');

    const date = entryDate ?? new Date();
    const fiscalYear = await this.prisma.fiscalYear.findFirst({
      where: { companyId, startDate: { lte: date }, endDate: { gte: date } },
      select: { id: true, startDate: true, endDate: true },
    });
    const existing = await this.prisma.journalEntry.findFirst({
      where: {
        companyId,
        documentType: 'OPENING',
        status: 'POSTED',
        ...(fiscalYear
          ? { entryDate: { gte: fiscalYear.startDate, lte: fiscalYear.endDate } }
          : {}),
      },
    });
    if (existing) {
      throw new ConflictError(
        fiscalYear ? 'OPENING_ALREADY_GENERATED_FOR_FISCAL_YEAR' : 'OPENING_ALREADY_GENERATED',
        { entryNumber: existing.entryNumber },
      );
    }

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
