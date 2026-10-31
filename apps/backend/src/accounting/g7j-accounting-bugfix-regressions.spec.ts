import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from './journal.service';
import { ReportsService } from './reports.service';
import { SubsidiaryLedgerService } from './subsidiary-ledger.service';
import { OpeningBalanceService } from './opening-balance.service';
import { SequencesService } from '../sequences/sequences.service';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import { TEST_INTEGRATION } from '../testing/integration';

jest.setTimeout(120000);

const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

/**
 * g7j — regression gates for the audited accounting bug list (BUG-02..13
 * subset that touches reporting/opening/reversal). Hermetic per-company
 * fixture, same pattern as g7i.
 */
describe('g7j — accounting bugfix regressions (hermetic live DB)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let audit: AuditService;
  let journal: JournalService;
  let reports: ReportsService;
  let subsidiary: SubsidiaryLedgerService;
  let opening: OpeningBalanceService;
  let COMPANY = '';
  const partyIds: string[] = [];

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
    opening = new OpeningBalanceService(prismaService as never, journal, new SequencesService(prismaService as never, audit), audit);

    const company = await prismaService.company.create({ data: { nameFa: `g7j-${Date.now()}`, status: 'ACTIVE' } });
    COMPANY = company.id;
    for (const a of [
      { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
      { code: 'RECEIVABLE', name: 'دریافتنی', type: 'ASSET' as const },
      { code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' as const },
      { code: 'OPENING_EQUITY', name: 'سرمایه', type: 'EQUITY' as const },
      { code: 'PARENT_1', name: 'دارایی‌ها', type: 'ASSET' as const },
    ]) {
      await prismaService.chartOfAccount.create({ data: { ...a, companyId: COMPANY } });
    }
    await prismaService.chartOfAccount.create({
      data: {
        code: 'CHILD_11',
        name: 'زیرمجموعه',
        type: 'ASSET',
        companyId: COMPANY,
        parentId: (await prismaService.chartOfAccount.findFirstOrThrow({ where: { companyId: COMPANY, code: 'PARENT_1' } })).id,
      },
    });
    await prismaService.sequence.create({
      data: { companyId: COMPANY, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
  });

  afterAll(async () => {
    if (!prismaService) return;
    const myLineIds = (await prismaService.journalLine.findMany({ where: { companyId: COMPANY }, select: { id: true } })).map((l) => l.id);
    await prismaService.journalLineAnalytic.deleteMany({ where: { journalLineId: { in: myLineIds } } });
    await prismaService.journalLine.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.fiscalYear.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.party.deleteMany({ where: { id: { in: partyIds } } });
    await prismaService.chartOfAccount.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.sequence.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    await prismaService.$disconnect();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  async function makeParty(name: string): Promise<{ id: string; nameFa: string }> {
    const party = await prismaService.party.create({
      data: { companyId: COMPANY, type: 'COMPANY', nameFa: name, roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    partyIds.push(party.id);
    return { id: party.id, nameFa: party.nameFa };
  }

  async function postBalanced(
    date: Date,
    lines: Array<{
      accountCode: string;
      debit: string | number;
      credit: string | number;
      partyId?: string;
      analytics?: { dimensionType: string; dimensionId: string }[];
    }>,
  ) {
    return prismaService.$transaction((tx) =>
      journal.post(tx, {
        companyId: COMPANY,
        entryDate: date,
        journalCode: 'OPERATIONAL',
        documentType: 'G7J_TEST',
        lines: lines as never,
        createdBy: ACTOR.id,
      }),
    );
  }

  itif('g7j-01 (BUG-02) party-filtered GL: opening, closing and page-2 running all share the filter', async () => {
    const a = await makeParty(`g7j-A-${Date.now()}`);
    const b = await makeParty(`g7j-B-${Date.now()}`);
    // January: A debit 300, B debit 100 — February: A debit 50, credit 20.
    await postBalanced(new Date('2026-01-10'), [
      { accountCode: 'RECEIVABLE', debit: 300, credit: 0, partyId: a.id },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 300 },
    ]);
    await postBalanced(new Date('2026-01-20'), [
      { accountCode: 'RECEIVABLE', debit: 100, credit: 0, partyId: b.id },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 100 },
    ]);
    await postBalanced(new Date('2026-02-05'), [
      { accountCode: 'RECEIVABLE', debit: 50, credit: 0, partyId: a.id },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 50 },
    ]);
    await postBalanced(new Date('2026-02-06'), [
      { accountCode: 'RECEIVABLE', debit: 0, credit: 20, partyId: a.id },
      { accountCode: 'BANK', debit: 20, credit: 0 },
    ]);

    const gl = await reports.generalLedger(COMPANY, {
      accountCode: 'RECEIVABLE',
      from: new Date('2026-02-01'),
      partyId: a.id,
    });
    // Opening = A's January balance ONLY (B's 100 must not leak in).
    expect(gl.openingBalance.toNumber()).toBe(300);
    // Closing = opening + A's February movement (50 - 20).
    expect(gl.totals.closingBalance.toNumber()).toBe(330);
    // Page-2 continuity: the cursor seed equals the same filter's aggregate.
    const page1 = await reports.generalLedger(COMPANY, { accountCode: 'RECEIVABLE', from: new Date('2026-02-01'), partyId: a.id, limit: 1 });
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await reports.generalLedger(COMPANY, {
      accountCode: 'RECEIVABLE', from: new Date('2026-02-01'), partyId: a.id, limit: 10, cursor: page1.nextCursor,
    });
    const lastRow = page2.rows[page2.rows.length - 1];
    expect(lastRow.runningBalance.toString()).toBe(page2.totals.closingBalance.toString());
  });

  itif('g7j-02 (BUG-03) TB totals identical across all/leaf/summary levels', async () => {
    await postBalanced(new Date(), [
      { accountCode: 'CHILD_11', debit: 333, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 333 },
    ]);
    const all = await reports.trialBalance(COMPANY, { level: 'all' });
    const leaf = await reports.trialBalance(COMPANY, { level: 'leaf' });
    const summary = await reports.trialBalance(COMPANY, { level: 'summary' });
    expect(all.totals.closingDebit.toString()).toBe(leaf.totals.closingDebit.toString());
    expect(all.totals.closingDebit.toString()).toBe(summary.totals.closingDebit.toString());
    // And the movement totals too (previously double-counted at level=all).
    expect(all.totals.debit.toString()).toBe(leaf.totals.debit.toString());
    expect(all.totals.credit.toString()).toBe(leaf.totals.credit.toString());
    expect(all.balanced).toBe(true);
  });

  itif('g7j-03 (BUG-04) direct posting on a parent account is preserved by the roll-up', async () => {
    // The fixture company accumulates data across tests — assert DELTAS so
    // the parent-posting contribution is measured exactly once.
    const before = await reports.trialBalance(COMPANY, { level: 'all' });
    await postBalanced(new Date(), [
      { accountCode: 'PARENT_1', debit: 77, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 77 },
    ]);
    const tb = await reports.trialBalance(COMPANY, { level: 'all' });
    const parent = tb.rows.find((r) => r.accountCode === 'PARENT_1')!;
    const child = tb.rows.find((r) => r.accountCode === 'CHILD_11')!;
    // Parent row = own direct posting (77) + child subtree (333) = 410.
    expect(parent.closingDebit.toNumber()).toBe(77 + child.closingDebit.toNumber());
    // Totals still count the new posting exactly once (roots-based, no
    // parent/child double count): grand total grows by exactly 77.
    expect(tb.totals.closingDebit.minus(before.totals.closingDebit).toNumber()).toBe(77);
  });

  itif('g7j-04 (BUG-05) partyBalances groupTotal is page-independent', async () => {
    // 6 parties × distinct balances; pageSize=2 → 3 pages, same total.
    const balances = [100, 200, 300, 400, 500, 600];
    for (const [i, amount] of balances.entries()) {
      const p = await makeParty(`g7j-P${i}-${Date.now()}`);
      await postBalanced(new Date(), [
        { accountCode: 'RECEIVABLE', debit: amount, credit: 0, partyId: p.id },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: amount },
      ]);
    }
    const pageTotals: number[] = [];
    for (let page = 1; page <= 3; page += 1) {
      const res = await subsidiary.partyBalances(COMPANY, { role: 'CUSTOMER', accountCode: 'RECEIVABLE', page, pageSize: 2 });
      pageTotals.push(res.groupTotal.toNumber());
      expect(res.items.length).toBe(2);
    }
    // Page-independence: all three pages report the SAME group total.
    expect(new Set(pageTotals.map(String)).size).toBe(1);
    // Cross-checked against an independent SQL aggregate over the WHOLE
    // filtered set (the fixture company accumulates earlier tests' data).
    const sql = await prisma.$queryRaw<Array<{ total: Prisma.Decimal | string | null }>>`
      SELECT COALESCE(SUM(l.debit - l.credit), 0) AS total
      FROM journal_lines l
      JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status IN ('POSTED', 'REVERSED')
      JOIN chart_of_accounts a ON a.id = l.account_id AND a.code = 'RECEIVABLE'
      JOIN parties p ON p.id = l.party_id
      JOIN party_roles pr ON pr.party_id = p.id AND pr.role = 'CUSTOMER'::"PartyRoleType"
      WHERE p.company_id = ${COMPANY}::uuid AND p.archived_at IS NULL`;
    expect(pageTotals[0]).toBe(new Prisma.Decimal(sql[0]!.total ?? 0).toNumber());
  });

  itif('g7j-05 (BUG-06) partyLedger closing = opening + period movement', async () => {
    const p = await makeParty(`g7j-L-${Date.now()}`);
    await postBalanced(new Date('2026-01-05'), [
      { accountCode: 'RECEIVABLE', debit: 500, credit: 0, partyId: p.id },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 500 },
    ]);
    await postBalanced(new Date('2026-02-10'), [
      { accountCode: 'RECEIVABLE', debit: 200, credit: 0, partyId: p.id },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 200 },
    ]);
    await postBalanced(new Date('2026-02-11'), [
      { accountCode: 'RECEIVABLE', debit: 0, credit: 100, partyId: p.id },
      { accountCode: 'BANK', debit: 100, credit: 0 },
    ]);
    const full = await subsidiary.partyLedger(COMPANY, p.id, { accountCode: 'RECEIVABLE' });
    const windowed = await subsidiary.partyLedger(COMPANY, p.id, {
      accountCode: 'RECEIVABLE', from: new Date('2026-02-01'), to: new Date('2026-02-28'),
    });
    expect(full.closingBalance.toNumber()).toBe(600);
    expect(windowed.openingBalance.toNumber()).toBe(500);
    expect(windowed.closingBalance.toNumber()).toBe(600);
    // The windowed ledger's LAST running balance equals the closing.
    expect(windowed.rows[windowed.rows.length - 1].runningBalance.toNumber()).toBe(600);
  });

  itif('g7j-06 (BUG-07) opening entries are per fiscal year, not per company', async () => {
    const fy26 = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1405', nameFa: 'سال ۱۴۰۵',
        startDate: new Date('2026-03-21'), endDate: new Date('2027-03-20'),
        periods: { create: [{ code: '1405-ALL', nameFa: 'کل سال', startDate: new Date('2026-03-21'), endDate: new Date('2027-03-20') }] },
      },
    });
    const fy27 = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1406', nameFa: 'سال ۱۴۰۶',
        startDate: new Date('2027-03-21'), endDate: new Date('2028-03-20'),
        periods: { create: [{ code: '1406-ALL', nameFa: 'کل سال', startDate: new Date('2027-03-21'), endDate: new Date('2028-03-20') }] },
      },
    });
    // FY 1405 opening: BANK 1000 / OPENING_EQUITY 1000.
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 1000 }], ACTOR);
    const e1 = await opening.generate(COMPANY, ACTOR, new Date('2026-04-01'));
    expect(e1.documentType).toBe('OPENING');
    // Same FY again → rejected with the FY-scoped error.
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 1 }], ACTOR);
    await expect(opening.generate(COMPANY, ACTOR, new Date('2026-05-01'))).rejects.toThrow('OPENING_ALREADY_GENERATED');
    // A different FY generates INDEPENDENTLY.
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 2000 }], ACTOR);
    const e2 = await opening.generate(COMPANY, ACTOR, new Date('2027-04-01'));
    expect(e2.id).not.toBe(e1.id);
    // Staged rows were stamped with their fiscal year.
    const stamped = await prismaService.openingBalanceEntry.findFirstOrThrow({
      where: { companyId: COMPANY, status: 'GENERATED', journalEntryId: e2.id },
    });
    expect(stamped.fiscalYearId).toBe(fy27.id);
    expect(fy26.id).toBeTruthy();
  });

  itif('g7j-07 (BUG-09) staging a cross-company party reference is rejected', async () => {
    const other = await prismaService.company.create({ data: { nameFa: `g7j-other-${Date.now()}`, status: 'ACTIVE' } });
    const foreignParty = await prismaService.party.create({
      data: { companyId: other.id, type: 'COMPANY', nameFa: 'شرکت دیگر' },
    });
    await expect(
      opening.stage(COMPANY, [{ accountCode: 'RECEIVABLE', debit: 100, partyId: foreignParty.id }], ACTOR),
    ).rejects.toThrow('OPENING_PARTY_NOT_IN_COMPANY');
    await prismaService.party.delete({ where: { id: foreignParty.id } }).catch(() => undefined);
    await prismaService.company.delete({ where: { id: other.id } }).catch(() => undefined);
  });

  itif('g7j-08 (BUG-13) reversal carries analytic dimensions; filtered report nets to zero', async () => {
    const p = await makeParty(`g7j-REV-${Date.now()}`);
    const entry = await postBalanced(new Date(), [
      {
        accountCode: 'RECEIVABLE', debit: 100000, credit: 0, partyId: p.id,
        analytics: [{ dimensionType: 'CUSTOMER', dimensionId: p.id }],
      },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 100000 },
    ]);
    const { reversal } = await journal.reverse(entry.id, ACTOR);
    // post() returns lines WITHOUT the analytics relation — read the stored
    // reversal lines back with their analytics.
    const reversalRows = await prisma.journalLine.findMany({
      where: { journalEntryId: reversal.id },
      include: { analytics: true },
    });
    const analyticLines = reversalRows.filter((l) => l.analytics.length > 0);
    expect(analyticLines).toHaveLength(1);
    expect(analyticLines[0].analytics[0]).toMatchObject({ dimensionType: 'CUSTOMER', dimensionId: p.id });
    // Dimension-filtered GL: original + reversal net to ZERO.
    const gl = await reports.generalLedger(COMPANY, {
      accountCode: 'RECEIVABLE',
      analyticType: 'CUSTOMER',
      analyticId: p.id,
    });
    const net = gl.rows.reduce((s, r) => s.plus(r.debit).minus(r.credit), new Prisma.Decimal(0));
    expect(net.toNumber()).toBe(0);
  });
});
