import { Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationError } from '../common/errors';

type Tx = Prisma.TransactionClient;

export interface LedgerRow {
  entryId: string;
  entryNumber: string;
  entryDate: Date;
  journalCode: string;
  documentType: string | null;
  description: string | null;
  debit: Prisma.Decimal;
  credit: Prisma.Decimal;
  runningBalance: Prisma.Decimal;
  reversed: boolean;
}

export interface LedgerReport {
  accountCode: string;
  accountName: string;
  normalSide: 'DEBIT' | 'CREDIT';
  openingBalance: Prisma.Decimal;
  rows: LedgerRow[];
  totals: { debit: Prisma.Decimal; credit: Prisma.Decimal; closingBalance: Prisma.Decimal };
}

/** Reports read ONLY from accounting entries + snapshots (docs/06). */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalSide(type: AccountType): 'DEBIT' | 'CREDIT' {
    return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
  }

  /**
   * General Ledger for one account (or subtree roll-up): opening balance
   * before `from`, row-per-line with running balance, totals.
   */
  async generalLedger(
    companyId: string,
    opts: { accountCode: string; from?: Date; to?: Date; includeReversed?: boolean },
  ): Promise<LedgerReport> {
    const account = await this.prisma.chartOfAccount.findFirst({
      where: { companyId, code: opts.accountCode },
    });
    if (!account) throw new ValidationError('ACCOUNT_NOT_FOUND', { accountCode: opts.accountCode });
    const normalSide = this.normalSide(account.type);
    const sign = normalSide === 'DEBIT' ? 1 : -1;

    const dateFilter = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lte: opts.to } : {}),
    };
    const entryWhere: Prisma.JournalEntryWhereInput = {
      companyId,
      status: { in: opts.includeReversed ? ['POSTED', 'REVERSED'] : ['POSTED'] },
      ...(Object.keys(dateFilter).length ? { entryDate: dateFilter } : {}),
    };

    // Opening balance: sum over lines before `from` (all POSTED history).
    const openingAgg = await this.prisma.journalLine.aggregate({
      where: {
        companyId,
        accountId: account.id,
        entry: {
          companyId,
          status: 'POSTED',
          ...(opts.from ? { entryDate: { lt: opts.from } } : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });
    const openingBalance = new Prisma.Decimal(
      (Number(openingAgg._sum.debit ?? 0) - Number(openingAgg._sum.credit ?? 0)) * sign,
    );

    const lines = await this.prisma.journalLine.findMany({
      where: { companyId, accountId: account.id, entry: entryWhere },
      orderBy: [{ entry: { entryDate: 'asc' } }, { id: 'asc' }],
      select: {
        id: true,
        debit: true,
        credit: true,
        description: true,
        entry: {
          select: {
            id: true,
            entryNumber: true,
            entryDate: true,
            journalCode: true,
            documentType: true,
            status: true,
          },
        },
      },
    });

    let running = openingBalance;
    const rows: LedgerRow[] = lines.map((l) => {
      running = running.plus(
        new Prisma.Decimal((Number(l.debit) - Number(l.credit)) * sign),
      );
      return {
        entryId: l.entry.id,
        entryNumber: l.entry.entryNumber,
        entryDate: l.entry.entryDate,
        journalCode: l.entry.journalCode,
        documentType: l.entry.documentType,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
        runningBalance: running,
        reversed: l.entry.status === 'REVERSED',
      };
    });

    const totals = rows.reduce(
      (acc, r) => ({
        debit: acc.debit.plus(r.debit),
        credit: acc.credit.plus(r.credit),
        closingBalance: r.runningBalance,
      }),
      { debit: new Prisma.Decimal(0), credit: new Prisma.Decimal(0), closingBalance: openingBalance },
    );

    return {
      accountCode: account.code,
      accountName: account.name,
      normalSide,
      openingBalance,
      rows,
      totals,
    };
  }

  /** Trial balance as-of a date: opening / movement / closing per account. */
  async trialBalance(companyId: string, asOf: Date, includeReversed = false) {
    const accounts = await this.prisma.chartOfAccount.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
    const before = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        companyId,
        entry: { companyId, status: 'POSTED', entryDate: { lt: asOf } },
      },
      _sum: { debit: true, credit: true },
    });
    const within = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        companyId,
        entry: { companyId, status: 'POSTED', entryDate: { lte: asOf } },
      },
      _sum: { debit: true, credit: true },
    });
    const beforeMap = new Map(before.map((r) => [r.accountId, r]));
    const withinMap = new Map(within.map((r) => [r.accountId, r]));

    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    const rows = accounts
      .map((account) => {
        const sign = new Prisma.Decimal(this.normalSide(account.type) === 'DEBIT' ? 1 : -1);
        const b = beforeMap.get(account.id);
        const w = withinMap.get(account.id);
        const opening = new Prisma.Decimal(
          (Number(b?._sum.debit ?? 0) - Number(b?._sum.credit ?? 0)) * sign.toNumber(),
        );
        // within = ALL posted lines ≤ asOf (no lower bound by default) — so
        // closing MUST be the signed sum of `within` itself, never opening +
        // movement (that would double-count everything before asOf).
        const debit = new Prisma.Decimal(w?._sum.debit ?? 0);
        const credit = new Prisma.Decimal(w?._sum.credit ?? 0);
        const closing = new Prisma.Decimal(
          (Number(debit) - Number(credit)) * sign.toNumber(),
        );
        // Placement by NORMAL side: positive signed balance → normal-side
        // column; negative → opposite column. For REVENUE (credit-normal),
        // +1000 means a CREDIT balance of 1000 — putting it in closingDebit
        // would break the balanced invariant.
        const normalDebit = this.normalSide(account.type) === 'DEBIT';
        const place = (v: Prisma.Decimal): { d: Prisma.Decimal; c: Prisma.Decimal } => {
          // + → normal-side column; − → the OPPOSITE column (exactly ONE column!)
          if (v.isZero()) return { d: new Prisma.Decimal(0), c: new Prisma.Decimal(0) };
          const abs = v.gte(0) ? v : new Prisma.Decimal(0).minus(v);
          return normalDebit
            ? v.gte(0)
              ? { d: abs, c: new Prisma.Decimal(0) }
              : { d: new Prisma.Decimal(0), c: abs }
            : v.gte(0)
              ? { d: new Prisma.Decimal(0), c: abs }
              : { d: abs, c: new Prisma.Decimal(0) };
        };
        const openingPlaced = place(opening);
        const closingPlaced = place(closing);
        const row = {
          accountCode: account.code,
          accountName: account.name,
          accountType: account.type,
          openingDebit: openingPlaced.d,
          openingCredit: openingPlaced.c,
          debit,
          credit,
          closingDebit: closingPlaced.d,
          closingCredit: closingPlaced.c,
        };
        totalDebit = totalDebit.plus(row.closingDebit);
        totalCredit = totalCredit.plus(row.closingCredit);
        return row;
      })
      .filter((r) => !r.openingDebit.isZero() || !r.openingCredit.isZero() || !r.debit.isZero() || !r.credit.isZero());

    return {
      asOf,
      rows,
      totals: {
        openingDebit: rows.reduce((s, r) => s.plus(r.openingDebit), new Prisma.Decimal(0)),
        openingCredit: rows.reduce((s, r) => s.plus(r.openingCredit), new Prisma.Decimal(0)),
        debit: rows.reduce((s, r) => s.plus(r.debit), new Prisma.Decimal(0)),
        credit: rows.reduce((s, r) => s.plus(r.credit), new Prisma.Decimal(0)),
        closingDebit: totalDebit,
        closingCredit: totalCredit,
      },
      balanced: totalDebit.equals(totalCredit),
    };
  }
}
