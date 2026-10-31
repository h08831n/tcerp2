import { Injectable } from '@nestjs/common';
import { AccountType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationError } from '../common/errors';

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
  /** true for the REVERSED side of a reversal pair (original or mirror). */
  reversed: boolean;
  /** mirror entry of a reversal pair for audit drill-down. */
  reversalEntryId: string | null;
}

export interface LedgerReport {
  accountCode: string;
  accountName: string;
  accountIds: string[];
  normalSide: 'DEBIT' | 'CREDIT';
  openingBalance: Prisma.Decimal;
  rows: LedgerRow[];
  nextCursor: string | null;
  totals: { debit: Prisma.Decimal; credit: Prisma.Decimal; closingBalance: Prisma.Decimal };
}

/** Reports read ONLY from accounting entries + snapshots (docs/06). */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  private normalSide(type: AccountType): 'DEBIT' | 'CREDIT' {
    return type === 'ASSET' || type === 'EXPENSE' ? 'DEBIT' : 'CREDIT';
  }

  /** Resolve an account code to its subtree ids (account + all descendants). */
  async resolveAccountSubtree(
    companyId: string,
    accountCode: string,
  ): Promise<{ account: { id: string; code: string; name: string; type: AccountType }; ids: string[] }> {
    const all = await this.prisma.chartOfAccount.findMany({
      where: { companyId },
      select: { id: true, code: true, name: true, type: true, parentId: true },
    });
    const root = all.find((a) => a.code === accountCode);
    if (!root) throw new ValidationError('ACCOUNT_NOT_FOUND', { accountCode });
    const ids = [root.id];
    let frontier = [root.id];
    while (frontier.length > 0) {
      const children = all.filter((a) => a.parentId && frontier.includes(a.parentId));
      if (children.length === 0) break;
      for (const c of children) if (!ids.includes(c.id)) ids.push(c.id);
      frontier = children.map((c) => c.id);
    }
    return { account: { id: root.id, code: root.code, name: root.name, type: root.type }, ids };
  }

  /**
   * General Ledger with keyset pagination (order: entryDate, entryNumber,
   * journalLineId). Net semantics (integrity gate #1): REVERSED originals AND
   * their POSTED reversals are BOTH included — they cancel arithmetically.
   * Totals cover the WHOLE filter range, never just the page.
   */
  async generalLedger(
    companyId: string,
    opts: {
      accountCode: string;
      from?: Date;
      to?: Date;
      journalCode?: string;
      partyId?: string;
      analyticType?: string;
      analyticId?: string;
      limit?: number;
      cursor?: string | null;
    },
  ): Promise<LedgerReport & { nextCursor: string | null }> {
    const { account, ids } = await this.resolveAccountSubtree(companyId, opts.accountCode);
    const normalSide = this.normalSide(account.type);
    const sign = new Prisma.Decimal(normalSide === 'DEBIT' ? 1 : -1);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

    const entryWhere: Prisma.JournalEntryWhereInput = {
      companyId,
      status: { in: ['POSTED', 'REVERSED'] }, // net: both sides of reversal pair
      ...(opts.from || opts.to
        ? { entryDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
        : {}),
      ...(opts.journalCode ? { journalCode: opts.journalCode } : {}),
    };
    const lineWhere: Prisma.JournalLineWhereInput = {
      companyId,
      accountId: { in: ids },
      entry: entryWhere,
      ...(opts.partyId ? { partyId: opts.partyId } : {}),
      ...(opts.analyticType && opts.analyticId
        ? { analytics: { some: { dimensionType: opts.analyticType as never, dimensionId: opts.analyticId } } }
        : {}),
    };

    // Opening balance = signed sum BEFORE the window start. Without `from`
    // the window starts at history begin → opening is zero by definition
    // (all rows appear in the ledger itself). It shares the party/analytic
    // filters with the rows (BUG-02): a party-filtered ledger must open on
    // THAT party's balance, or page-2 running balances (which re-aggregate
    // with the filters) would disagree with page 1 and closingBalance would
    // mix scopes.
    let openingBalance = new Prisma.Decimal(0);
    if (opts.from) {
      const openingAgg = await this.prisma.journalLine.aggregate({
        where: {
          companyId,
          accountId: { in: ids },
          ...(opts.partyId ? { partyId: opts.partyId } : {}),
          ...(opts.analyticType && opts.analyticId
            ? { analytics: { some: { dimensionType: opts.analyticType as never, dimensionId: opts.analyticId } } }
            : {}),
          entry: {
            companyId,
            status: { in: ['POSTED', 'REVERSED'] },
            entryDate: { lt: opts.from },
            ...(opts.journalCode ? { journalCode: opts.journalCode } : {}),
          },
        },
        _sum: { debit: true, credit: true },
      });
      openingBalance = new Prisma.Decimal(openingAgg._sum.debit ?? 0)
        .minus(new Prisma.Decimal(openingAgg._sum.credit ?? 0))
        .times(sign);
    }

    let cursorData: { d: string; n: string; l: string } | null = null;
    if (opts.cursor) {
      try {
        cursorData = JSON.parse(Buffer.from(opts.cursor, 'base64').toString('utf-8'));
      } catch {
        throw new ValidationError('INVALID_LEDGER_CURSOR');
      }
    }

    // Keyset branches each carry the full company/status scoping — an OR
    // branch without companyId would aggregate other companies' lines into
    // the running-balance seed (root cause of cross-page drift).
    const entryScope: Prisma.JournalEntryWhereInput = {
      companyId,
      status: { in: ['POSTED', 'REVERSED'] as ('POSTED' | 'REVERSED')[] },
    };
    const cursorFilter: Prisma.JournalLineWhereInput[] = cursorData
      ? [
          { entry: { ...entryScope, entryDate: { gt: new Date(cursorData.d) } } },
          { entry: { ...entryScope, entryDate: new Date(cursorData.d), entryNumber: { gt: cursorData.n } } },
          { entry: { ...entryScope, entryDate: new Date(cursorData.d), entryNumber: cursorData.n }, id: { gt: cursorData.l } },
        ]
      : [];

    const lines = await this.prisma.journalLine.findMany({
      where: {
        AND: [lineWhere, ...(cursorFilter.length ? [{ OR: cursorFilter }] : [])],
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { entryNumber: 'asc' } }, { id: 'asc' }],
      take: limit + 1,
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
            reversedByEntryId: true,
          },
        },
      },
    });

    const hasMore = lines.length > limit;
    const page = hasMore ? lines.slice(0, limit) : lines;

    let running = openingBalance;
    if (cursorData) {
      // BUG-01 (residual caught by g7j-01): the in-window before-cursor sum
      // must CONTINUE from the opening balance, not replace it — with a
      // `from` filter the pre-window balance lives only in openingBalance.
      const beforeCursor = await this.prisma.journalLine.aggregate({
        where: {
          AND: [
            lineWhere,
            {
              OR: [
                { entry: { ...entryScope, entryDate: { lt: new Date(cursorData.d) } } },
                { entry: { ...entryScope, entryDate: new Date(cursorData.d), entryNumber: { lt: cursorData.n } } },
                { entry: { ...entryScope, entryDate: new Date(cursorData.d), entryNumber: cursorData.n }, id: { lte: cursorData.l } },
              ],
            },
          ],
        },
        _sum: { debit: true, credit: true },
      });
      running = openingBalance.plus(
        new Prisma.Decimal(beforeCursor._sum?.debit ?? 0)
          .minus(new Prisma.Decimal(beforeCursor._sum?.credit ?? 0))
          .times(sign),
      );
    }

    const rows: LedgerRow[] = page.map((l) => {
      running = running.plus(new Prisma.Decimal(l.debit).minus(l.credit).times(sign));
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
        reversalEntryId: l.entry.reversedByEntryId,
      };
    });

    const totalsAgg = await this.prisma.journalLine.aggregate({
      where: lineWhere,
      _sum: { debit: true, credit: true },
    });
    const totals = {
      debit: new Prisma.Decimal(totalsAgg._sum.debit ?? 0),
      credit: new Prisma.Decimal(totalsAgg._sum.credit ?? 0),
      closingBalance: openingBalance.plus(
        new Prisma.Decimal(totalsAgg._sum.debit ?? 0)
          .minus(new Prisma.Decimal(totalsAgg._sum.credit ?? 0))
          .times(normalSide === 'DEBIT' ? 1 : -1),
      ),
    };

    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? Buffer.from(
            JSON.stringify({ d: last.entry.entryDate.toISOString(), n: last.entry.entryNumber, l: last.id }),
          ).toString('base64')
        : null;

    return {
      accountCode: account.code,
      accountName: account.name,
      accountIds: ids,
      normalSide,
      openingBalance,
      rows,
      nextCursor,
      totals,
    };
  }

  /**
   * Trial balance (integrity gates #2/#3): real from/to windows with
   * opening = before FROM, movement = FROM..TO, closing = opening + movement
   * (signed per normal side — no double counting). Real hierarchical roll-up:
   * postings live on leaves; parents roll up descendants. Reversal pairs both
   * included (net zero). level: leaf | summary | all.
   */
  async trialBalance(
    companyId: string,
    opts: { from?: Date; to?: Date; asOf?: Date; fiscalYearId?: string; periodId?: string; level?: 'leaf' | 'summary' | 'all' },
  ) {
    const level = opts.level ?? 'all';
    let from = opts.from ?? null;
    let to = opts.to ?? opts.asOf ?? new Date();
    if (opts.fiscalYearId) {
      const fy = await this.prisma.fiscalYear.findFirst({ where: { id: opts.fiscalYearId, companyId } });
      if (!fy) throw new ValidationError('FISCAL_YEAR_NOT_FOUND');
      from = from ?? fy.startDate;
      if (!opts.periodId) to = opts.to ?? fy.endDate;
    }
    if (opts.periodId) {
      const period = await this.prisma.fiscalPeriod.findFirst({
        where: { id: opts.periodId, fiscalYear: { companyId } },
      });
      if (!period) throw new ValidationError('FISCAL_PERIOD_NOT_FOUND');
      from = from ?? period.startDate;
      to = period.endDate;
    }

    const accounts = await this.prisma.chartOfAccount.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
    });
    const leafIds = new Set(accounts.filter((a) => !accounts.some((c) => c.parentId === a.id)).map((a) => a.id));
    const childrenOf = new Map<string, string[]>();
    for (const a of accounts) {
      if (a.parentId) childrenOf.set(a.parentId, [...(childrenOf.get(a.parentId) ?? []), a.id]);
    }

    const signed = (d: Prisma.Decimal | null | undefined, c: Prisma.Decimal | null | undefined, type: AccountType) =>
      new Prisma.Decimal(d ?? 0).minus(new Prisma.Decimal(c ?? 0)).times(
        this.normalSide(type) === 'DEBIT' ? 1 : -1,
      );

    const status = { in: ['POSTED', 'REVERSED'] as ('POSTED' | 'REVERSED')[] };
    // Opening window exists only when `from` is given — without it the whole
    // history is the movement window and beforeSums must stay EMPTY (else
    // closing double-counts).
    const beforeSums = from
      ? await this.prisma.journalLine.groupBy({
          by: ['accountId'],
          where: { companyId, entry: { companyId, status, entryDate: { lt: from } } },
          _sum: { debit: true, credit: true },
        })
      : [];
    // eslint-disable-next-line no-console
    const beforeMap = new Map(beforeSums.map((r) => [r.accountId, r]));
    const periodSums = await this.prisma.journalLine.groupBy({
      by: ['accountId'],
      where: {
        companyId,
        entry: {
          companyId,
          status,
          // single combined entryDate object — separate spreads on the same
          // key would silently overwrite each other (last-wins)
          ...(from || to
            ? { entryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
            : {}),
        },
      },
      _sum: { debit: true, credit: true },
    });
    const periodMap = new Map(periodSums.map((r) => [r.accountId, r]));
    // eslint-disable-next-line no-console

    const leafBalances = new Map<string, { opening: Prisma.Decimal; periodDebit: Prisma.Decimal; periodCredit: Prisma.Decimal; closing: Prisma.Decimal }>();
    // BUG-04 policy (documented): direct postings on a NON-leaf account are
    // allowed (data imports/opening balances may carry parent codes) and are
    // NEVER dropped — rollup(id) = own direct sums + descendants. BUG-03
    // totals are computed over LEAF balances only, so the grand total is
    // independent of the display level (all/leaf/summary) and can never
    // double-count parents.
    for (const account of accounts) {
      const b = beforeMap.get(account.id);
      const p = periodMap.get(account.id);
      leafBalances.set(account.id, {
        opening: signed(b?._sum.debit, b?._sum.credit, account.type),
        periodDebit: new Prisma.Decimal(p?._sum.debit ?? 0),
        periodCredit: new Prisma.Decimal(p?._sum.credit ?? 0),
        closing: signed(
          new Prisma.Decimal(b?._sum.debit ?? 0).plus(new Prisma.Decimal(p?._sum.debit ?? 0)),
          new Prisma.Decimal(b?._sum.credit ?? 0).plus(new Prisma.Decimal(p?._sum.credit ?? 0)),
          account.type,
        ),
      });
    }

    const rollup = (id: string, kind: 'opening' | 'periodDebit' | 'periodCredit' | 'closing'): Prisma.Decimal => {
      const leaf = leafBalances.get(id);
      let total =
        kind === 'opening'
          ? leaf?.opening ?? new Prisma.Decimal(0)
          : kind === 'closing'
            ? leaf?.closing ?? new Prisma.Decimal(0)
            : kind === 'periodDebit'
              ? leaf?.periodDebit ?? new Prisma.Decimal(0)
              : leaf?.periodCredit ?? new Prisma.Decimal(0);
      for (const child of childrenOf.get(id) ?? []) total = total.plus(rollup(child, kind));
      return total;
    };

    const place = (v: Prisma.Decimal, normalDebit: boolean) => {
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

    // BUG-03: grand totals are the sum over ROOT accounts' rollups — every
    // posting is counted EXACTLY once regardless of the display level.
    // (Summing the displayed rows double-counts at level=all, where a parent
    // row and its child rows are both visible.)
    const roots = accounts.filter((a) => !a.parentId);
    let totalDebit = new Prisma.Decimal(0);
    let totalCredit = new Prisma.Decimal(0);
    for (const root of roots) {
      const placed = place(rollup(root.id, 'closing'), this.normalSide(root.type) === 'DEBIT');
      totalDebit = totalDebit.plus(placed.d);
      totalCredit = totalCredit.plus(placed.c);
    }

    const rows = accounts
      .filter((a) => (level === 'leaf' ? leafIds.has(a.id) : level === 'summary' ? childrenOf.has(a.id) : true))
      .filter((a) => {
        const o = rollup(a.id, 'opening');
        const d = rollup(a.id, 'periodDebit');
        const c = rollup(a.id, 'periodCredit');
        const cl = rollup(a.id, 'closing');
        return !o.isZero() || !d.isZero() || !c.isZero() || !cl.isZero();
      })
      .map((account) => {
        const normalDebit = this.normalSide(account.type) === 'DEBIT';
        const openingPlaced = place(rollup(account.id, 'opening'), normalDebit);
        const closingPlaced = place(rollup(account.id, 'closing'), normalDebit);
        return {
          accountCode: account.code,
          accountName: account.name,
          accountType: account.type,
          level: childrenOf.has(account.id) ? 'parent' : 'leaf',
          openingDebit: openingPlaced.d,
          openingCredit: openingPlaced.c,
          debit: rollup(account.id, 'periodDebit'),
          credit: rollup(account.id, 'periodCredit'),
          closingDebit: closingPlaced.d,
          closingCredit: closingPlaced.c,
        };
      });

    return {
      from,
      to,
      level,
      rows,
      totals: {
        openingDebit: roots.reduce((s, r) => s.plus(place(rollup(r.id, 'opening'), this.normalSide(r.type) === 'DEBIT').d), new Prisma.Decimal(0)),
        openingCredit: roots.reduce((s, r) => s.plus(place(rollup(r.id, 'opening'), this.normalSide(r.type) === 'DEBIT').c), new Prisma.Decimal(0)),
        debit: roots.reduce((s, r) => s.plus(rollup(r.id, 'periodDebit')), new Prisma.Decimal(0)),
        credit: roots.reduce((s, r) => s.plus(rollup(r.id, 'periodCredit')), new Prisma.Decimal(0)),
        closingDebit: totalDebit,
        closingCredit: totalCredit,
      },
      balanced: totalDebit.equals(totalCredit),
    };
  }

  /** Journal-entry drill-down (Phase 7D): one posted entry with its lines,
   *  reversal linkage and reversal-of link — read-only, company-scoped. */
  async journalEntry(companyId: string, id: string) {
    const entry = await this.prisma.journalEntry.findFirst({
      where: { id, companyId },
      include: { lines: { include: { account: { select: { code: true, name: true } } } } },
    });
    if (!entry) throw new ValidationError('JOURNAL_ENTRY_NOT_FOUND', { id });
    // JournalLine carries partyId without a relation — resolve names in batch
    const partyIds = [...new Set(entry.lines.map((l) => l.partyId).filter((p): p is string => !!p))];
    const parties = partyIds.length
      ? await this.prisma.party.findMany({ where: { id: { in: partyIds } }, select: { id: true, nameFa: true } })
      : [];
    const partyNameById = new Map(parties.map((p) => [p.id, p.nameFa]));
    // a reversal entry is linked FROM the original via reversedByEntryId
    const reversalOf = await this.prisma.journalEntry.findFirst({
      where: { reversedByEntryId: entry.id, companyId },
      select: { id: true, entryNumber: true },
    });
    const reversedBy = entry.reversedByEntryId
      ? await this.prisma.journalEntry.findFirst({
          where: { id: entry.reversedByEntryId, companyId },
          select: { id: true, entryNumber: true },
        })
      : null;
    return {
      id: entry.id,
      entryNumber: entry.entryNumber,
      entryDate: entry.entryDate,
      journalCode: entry.journalCode,
      documentType: entry.documentType,
      description: entry.description,
      status: entry.status,
      reversedByEntryId: entry.reversedByEntryId,
      reversalOf: reversalOf ? { id: reversalOf.id, entryNumber: reversalOf.entryNumber } : null,
      reversedBy: reversedBy ? { id: reversedBy.id, entryNumber: reversedBy.entryNumber } : null,
      lines: entry.lines.map((l) => ({
        id: l.id,
        accountCode: l.account.code,
        accountName: l.account.name,
        partyId: l.partyId,
        partyNameFa: l.partyId ? partyNameById.get(l.partyId) ?? null : null,
        description: l.description,
        debit: l.debit,
        credit: l.credit,
      })),
    };
  }
}
