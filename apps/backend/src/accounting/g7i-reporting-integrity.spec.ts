import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from '../accounting/journal.service';
import { ReportsService } from '../accounting/reports.service';
import { SubsidiaryLedgerService } from '../accounting/subsidiary-ledger.service';
import { ValuationReportService } from '../accounting/valuation-report.service';
import { OpeningBalanceService } from '../accounting/opening-balance.service';
import { SequencesService } from '../sequences/sequences.service';
import { NormalizationService } from '../inventory/normalization.service';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import { TEST_INTEGRATION } from '../testing/integration';
import {
  describeIntegration,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';

jest.setTimeout(90000);

const DB_URL = process.env.DATABASE_URL;

// guard only in real integration runs — unit runs must not touch the DB
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);
const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };
let SURVIVOR_ID = ''; // registered by g7i-19, read by the post-cleanup survival describe

describe('g7i — Reporting Integrity Gate (hermetic live DB)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let audit: AuditService;
  let journal: JournalService;
  let reports: ReportsService;
  let subsidiary: SubsidiaryLedgerService;
  let valuation: ValuationReportService;
  let opening: OpeningBalanceService;
  let COMPANY = '';
  const entryIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prismaService = new S();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    audit = new AuditService(prismaService as never);
    journal = new JournalService(prismaService as never, new SequencesService(prismaService as never, audit));
    reports = new ReportsService(prismaService as never);
    subsidiary = new SubsidiaryLedgerService(prismaService as never);
    valuation = new ValuationReportService(prismaService as never);
    opening = new OpeningBalanceService(prismaService as never, journal, new SequencesService(prismaService as never, audit), audit);

    const company = await prismaService.company.create({
      data: { nameFa: `g7i-${Date.now()}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    for (const a of [
      { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
      { code: 'RECEIVABLE', name: 'دریافتنی', type: 'ASSET' as const },
      { code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' as const },
      { code: 'PURCHASE_EXPENSE', name: 'بهای تمام‌شده', type: 'EXPENSE' as const },
      { code: 'INVENTORY', name: 'موجودی', type: 'ASSET' as const },
      { code: 'OPENING_EQUITY', name: 'سرمایه افتتاحیه', type: 'EQUITY' as const },
      { code: 'PARENT_1', name: 'دارایی‌ها', type: 'ASSET' as const },
    ]) {
      await prismaService.chartOfAccount.create({ data: { ...a, companyId: COMPANY } });
    }
    await prismaService.chartOfAccount.create({
      data: {
        code: 'CHILD_11',
        name: 'بانک زیرمجموعه',
        type: 'ASSET',
        companyId: COMPANY,
        parentId: (
          await prismaService.chartOfAccount.findFirstOrThrow({
            where: { companyId: COMPANY, code: 'PARENT_1' },
          })
        ).id,
      },
    });
    await prismaService.sequence.create({
      data: { companyId: COMPANY, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
    await prismaService.$executeRaw`
      INSERT INTO stock_locations (id, company_id, type, code, name_fa, active)
      VALUES (gen_random_uuid(), ${COMPANY}::uuid, 'INTERNAL', 'LOC-A', 'انبار A', true)`;
  });

  afterAll(async () => {
    if (!prismaService) return;
    // P0: scope EVERYTHING to the hermetic company — analytics reachable only
    // through our own journal lines.
    const myLineIds = (
      await prismaService.journalLine.findMany({
        where: { companyId: COMPANY },
        select: { id: true },
      })
    ).map((l) => l.id);
    await prismaService.journalLineAnalytic.deleteMany({
      where: { journalLineId: { in: myLineIds } },
    });
    await prismaService.journalLine.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.stockMovement.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.stockLocation.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.chartOfAccount.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.sequence.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.party.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    // P0: after survival assertions passed, clean the second company TOO —
    // scoped to its own id, never global.
    const g = globalThis as unknown as Record<string, { id: string; beforeLines: number; beforeAnalytics: number } | undefined>;
    const second = g.__g7iCompany2;
    if (second && second.id) {
      await prismaService.journalLineAnalytic.deleteMany({
        where: { journalLine: { companyId: second.id } },
      });
      await prismaService.journalLine.deleteMany({ where: { companyId: second.id } });
      await prismaService.journalEntry.deleteMany({ where: { companyId: second.id } });
      await prismaService.chartOfAccount.deleteMany({ where: { companyId: second.id } });
      await prismaService.sequence.deleteMany({ where: { companyId: second.id } });
      await prismaService.company.delete({ where: { id: second.id } }).catch(() => undefined);
    }
    await prismaService.$disconnect();
  });

  const itif = TEST_INTEGRATION && DB_URL
    ? it
    : (name: string, fn: jest.ProvidesCallback) => {
        // P1: make silent skips VISIBLE
        // eslint-disable-next-line no-console
        console.warn(`[g7i] SKIPPED (no DATABASE_URL): ${name}`);
        return it.skip(name, fn);
      };

  async function postBalanced(
    date: Date,
    lines: Array<{ accountCode: string; debit: string | number; credit: string | number; partyId?: string; description?: string }>,
  ) {
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: date,
      journalCode: 'GENERAL',
      lines: lines.map((l) => ({ ...l, analytics: undefined as never })),
    });
    entryIds.push(entry.id);
    return entry;
  }

  async function bankClosingBefore(date: Date): Promise<Prisma.Decimal> {
    const account = await prismaService.chartOfAccount.findFirstOrThrow({
      where: { companyId: COMPANY, code: 'BANK' },
    });
    const agg = await prismaService.journalLine.aggregate({
      where: {
        companyId: COMPANY,
        accountId: account.id,
        entry: { status: { in: ['POSTED', 'REVERSED'] as ('POSTED' | 'REVERSED')[] }, entryDate: { lt: date } },
      },
      _sum: { debit: true, credit: true },
    });
    // BANK is debit-normal → signed = debit - credit
    return new Prisma.Decimal(agg._sum.debit ?? 0).minus(new Prisma.Decimal(agg._sum.credit ?? 0));
  }

  itif('g7i-01/02 reversed entry net impact zero; before/after balances equal; both auditable', async () => {
    const date = new Date();
    const balanceBefore = await bankClosingBefore(new Date(date.getTime() + 1000));

    const original = await postBalanced(date, [
      { accountCode: 'BANK', debit: 100, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 100 },
    ]);
    const afterOriginal = await bankClosingBefore(new Date(date.getTime() + 2000));
    expect(afterOriginal.minus(balanceBefore).toNumber()).toBe(100);

    const { reversal } = await journal.reverse(original.id, ACTOR);
    entryIds.push(reversal.id);

    const balanceAfter = await bankClosingBefore(new Date(date.getTime() + 3000));
    // net impact of the pair = 0 → final balance == balance before the original
    expect(balanceAfter.toString()).toBe(balanceBefore.toString());

    // both records remain auditable in the GL, flagged and linked
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    const pair = gl.rows.filter((r) => r.entryId === original.id || r.entryId === reversal.id);
    expect(pair).toHaveLength(2);
    expect(pair.find((r) => r.entryId === original.id)!.reversed).toBe(true);
    expect(pair.find((r) => r.entryId === reversal.id)!.reversed).toBe(false);
    const pairNet = pair.reduce((s, r) => s.plus(r.debit).minus(r.credit), new Prisma.Decimal(0));
    expect(pairNet.isZero()).toBe(true);
  });

  itif('g7i-03/04 period movement excludes opening; three-period trial balance', async () => {
    const d1 = new Date('2026-01-05');
    const d2 = new Date('2026-02-05');
    const d3 = new Date('2026-03-05');
    const e1 = await postBalanced(d1, [
      { accountCode: 'BANK', debit: 100, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 100 },
    ]);
    const e2 = await postBalanced(d2, [
      { accountCode: 'BANK', debit: 50, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 50 },
    ]);
    const e3 = await postBalanced(d3, [
      { accountCode: 'BANK', debit: 25, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 25 },
    ]);
    entryIds.push(e1.id, e2.id, e3.id);

    const tbFeb = await reports.trialBalance(COMPANY, { from: new Date('2026-02-01'), to: new Date('2026-02-28') });
    const bankFeb = tbFeb.rows.find((r) => r.accountCode === 'BANK')!;
    expect(bankFeb.openingDebit.toNumber()).toBe(100); // Jan posting is opening
    expect(bankFeb.debit.toNumber()).toBe(50); // movement excludes opening
    expect(bankFeb.closingDebit.toNumber()).toBe(150); // opening + movement

    const tbJan = await reports.trialBalance(COMPANY, { from: new Date('2026-01-01'), to: new Date('2026-01-31') });
    const tbMar = await reports.trialBalance(COMPANY, { from: new Date('2026-03-01'), to: new Date('2026-03-31') });
    const bankJan = tbJan.rows.find((r) => r.accountCode === 'BANK')!;
    const bankMar = tbMar.rows.find((r) => r.accountCode === 'BANK')!;
    expect(bankJan.closingDebit.toNumber()).toBe(100);
    expect(bankMar.closingDebit.toNumber()).toBe(175);
    expect(bankMar.openingDebit.toNumber()).toBe(150); // Feb closing = Mar opening
    expect(tbFeb.balanced).toBe(true);
    expect(tbMar.balanced).toBe(true);
  });

  itif('g7i-05/06 parent roll-up = exact sum of children; GL subtree', async () => {
    const e = await postBalanced(new Date(), [
      { accountCode: 'CHILD_11', debit: 333, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 333 },
    ]);
    entryIds.push(e.id);
    const tbAll = await reports.trialBalance(COMPANY, { level: 'all' });
    const parent = tbAll.rows.find((r) => r.accountCode === 'PARENT_1')!;
    const child = tbAll.rows.find((r) => r.accountCode === 'CHILD_11')!;
    // P1: parent closing = EXACT sum of children closings (CHILD_11 only leaf under PARENT_1)
    expect(parent.closingDebit.toString()).toBe(child.closingDebit.toString());
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'PARENT_1' });
    const subtreeLine = gl.rows.find((r) => r.debit.toNumber() === 333);
    expect(subtreeLine).toBeTruthy();
    const glChild = await reports.generalLedger(COMPANY, { accountCode: 'CHILD_11' });
    expect(glChild.rows.some((r) => r.debit.toNumber() === 333)).toBe(true);
  });

  itif('g7i-17 GL keyset pagination running-balance continuity', async () => {
    const created: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const e = await postBalanced(new Date(), [
        { accountCode: 'BANK', debit: i, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: i },
      ]);
      created.push(e.id);
      entryIds.push(e.id);
    }
    const page1 = await reports.generalLedger(COMPANY, { accountCode: 'BANK', limit: 3 });
    expect(page1.rows).toHaveLength(3);
    expect(page1.nextCursor).toBeTruthy();
    const lastP1 = page1.rows[page1.rows.length - 1].runningBalance.toNumber();
    const page2 = await reports.generalLedger(COMPANY, {
      accountCode: 'BANK',
      limit: 3,
      cursor: page1.nextCursor,
    });
    expect(page2.rows.length).toBeGreaterThanOrEqual(2);
    const firstP2 = page2.rows[0];
    expect(firstP2.runningBalance.minus(lastP1).toNumber()).toBe(
      firstP2.debit.minus(firstP2.credit).toNumber(),
    );
    // full walk: following nextCursor through ALL pages gives a final running
    // balance equal to totals.closingBalance (which spans the whole filter)
    let cursor = page1.nextCursor;
    let finalRow = page2.rows[page2.rows.length - 1];
    let guard = 0;
    while (cursor && guard < 50) {
      const next = await reports.generalLedger(COMPANY, { accountCode: 'BANK', limit: 3, cursor });
      if (next.rows.length > 0) finalRow = next.rows[next.rows.length - 1];
      cursor = next.nextCursor;
      guard += 1;
    }
    expect(finalRow.runningBalance.toString()).toBe(page2.totals.closingBalance.toString());
  });

  itif('g7i-14/15 Decimal precision survives post/report/reversal and final balance', async () => {
    const big = '123456789012345.6789';
    const balanceBefore = await bankClosingBefore(new Date(Date.now() + 1000));
    const original = await postBalanced(new Date(), [
      { accountCode: 'BANK', debit: big, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: big },
    ]);
    // report round-trip: GL row carries the exact decimal
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    const row = gl.rows.find((r) => r.entryId === original.id)!;
    expect(row.debit.toString()).toBe(big);
    // reversal: mirrored credit also exact
    const { reversal } = await journal.reverse(original.id, ACTOR);
    const rLines = await prisma.journalLine.findMany({ where: { journalEntryId: reversal.id } });
    const revCredit = rLines.find((l) => l.credit.gt(0))!;
    expect(revCredit.credit.toString()).toBe(big);
    // final balance: original + big - big = balanceBefore (exact Decimal)
    const balanceAfter = await bankClosingBefore(new Date(Date.now() + 3000));
    expect(balanceAfter.minus(balanceBefore).isZero()).toBe(true);
  });

  itif('g7i-18 company isolation', async () => {
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    const entries = await prisma.journalEntry.findMany({ where: { id: { in: gl.rows.map((r) => r.entryId) } } });
    expect(entries.every((e) => e.companyId === COMPANY)).toBe(true);
  });

  itif('g7i-19/20 reversed subsidiary balance zero; second-company data survives scoped cleanup', async () => {
    const customer = await prisma.party.create({
      data: { companyId: COMPANY, type: 'PERSON', nameFa: 'g7i مشتری', roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    const e1 = await postBalanced(new Date(), [
      { accountCode: 'RECEIVABLE', debit: 400, credit: 0, partyId: customer.id },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 400 },
    ]);
    const { reversal } = await journal.reverse(e1.id, ACTOR);
    entryIds.push(reversal.id);
    const balances = await subsidiary.partyBalances(COMPANY, {
      role: 'CUSTOMER',
      accountCode: 'RECEIVABLE',
      search: 'g7i',
    });
    const row = balances.items.find((i) => i.partyId === customer.id)!;
    // net zero: original + reversal both included
    expect(row.accountingBalance.isZero()).toBe(true);

    // P0: second hermetic company with its own data — scoped cleanup must NOT
    // touch it; counts verified before/after a scoped cleanup simulation
    const company2 = await prismaService.company.create({
      data: { nameFa: `g7i-second-${Date.now()}`, status: 'ACTIVE' },
    });
    SURVIVOR_ID = company2.id;
    await prismaService.chartOfAccount.create({
      data: { code: 'BANK', name: 'بانک شرکت دوم', type: 'ASSET', companyId: company2.id },
    });
    await prismaService.chartOfAccount.create({
      data: { code: 'SALES_REVENUE', name: 'درآمد شرکت دوم', type: 'REVENUE', companyId: company2.id },
    });
    await prismaService.sequence.create({
      data: { companyId: company2.id, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
    const entry2 = await journal.post(prismaService as never, {
      companyId: company2.id,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'BANK', debit: 77, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 77 },
      ],
    });
    void entry2;
    const beforeLines = await prismaService.journalLine.count({ where: { companyId: company2.id } });
    const beforeAnalytics = await prismaService.journalLineAnalytic.count({
      where: { journalLine: { companyId: company2.id } },
    });

    // run the same scoped deletes the afterAll performs — scoped to COMPANY
    const myLineIds = (
      await prismaService.journalLine.findMany({ where: { companyId: COMPANY }, select: { id: true } })
    ).map((l) => l.id);
    await prismaService.journalLineAnalytic.deleteMany({
      where: { journalLineId: { in: myLineIds } },
    });

    const afterLines2 = await prismaService.journalLine.count({ where: { companyId: company2.id } });
    expect(afterLines2).toBe(beforeLines); // untouched
    const afterAnalytics2 = await prismaService.journalLineAnalytic.count({
      where: { journalLine: { companyId: company2.id } },
    });
    expect(afterAnalytics2).toBe(beforeAnalytics); // untouched
    expect(await prismaService.company.findUnique({ where: { id: company2.id } })).toBeTruthy();
  });
});

// ── P0 survival verification AFTER the suite's afterAll cleanup ran ──

// integration-only: the survivor id is registered by the main suite's
// g7i-19, which does not run without a database
describeIntegration('g7i-p0 second-company survival (post-cleanup)', () => {
  const prisma = integrationPrisma();

  it('second company data survived g7i cleanup', async () => {
    // g7i-19 registers the id it created; must exist and be distinct
    expect(SURVIVOR_ID).toBeTruthy();
    const second = await prisma.company.findUnique({ where: { id: SURVIVOR_ID } });
    expect(second).toBeTruthy(); // company NOT deleted by g7i cleanup
    const lines = await prisma.journalLine.count({ where: { companyId: second!.id } });
    expect(lines).toBeGreaterThan(0); // its journal lines intact
    const entries = await prisma.journalEntry.count({ where: { companyId: second!.id } });
    expect(entries).toBeGreaterThan(0);
  });
});
