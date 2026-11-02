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
    // P1-7 (explicit display policy): at level=leaf the parent's OWN direct
    // posting is not a displayed row — the response must SAY so explicitly.
    const leaf = await reports.trialBalance(COMPANY, { level: 'leaf' });
    const declared = leaf.directPostingsOnNonLeaf.find((d) => d.accountCode === 'PARENT_1');
    expect(declared).toBeTruthy();
    expect(String(declared!.closing)).toBe('77');
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
    // FY 1405 opening: BANK 1000 / OPENING_EQUITY 1000 — rows BOUND to FY1405.
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 1000 }], ACTOR, fy26.id);
    const e1 = await opening.generate(COMPANY, ACTOR, new Date('2026-04-01'));
    expect(e1.documentType).toBe('OPENING');
    // Same FY again → rejected with the FY-scoped error.
    await expect(opening.generate(COMPANY, ACTOR, new Date('2026-05-01'))).rejects.toThrow('OPENING_ALREADY_GENERATED');
    // A different FY generates INDEPENDENTLY and consumes ONLY its own rows.
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 2000 }], ACTOR, fy27.id);
    const e2 = await opening.generate(COMPANY, ACTOR, new Date('2027-04-01'));
    expect(e2.id).not.toBe(e1.id);
    const e2Bank = await prisma.journalLine.findMany({
      where: { journalEntryId: e2.id, account: { code: 'BANK' } },
    });
    expect(e2Bank.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0)).toNumber()).toBe(2000);
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
    // Own fresh FY — the auto-bind target (FY1405) already has an OPENING
    // doc, and R3-6 blocks staging into it before reference validation.
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1415', nameFa: 'سال ۱۴۱۵',
        startDate: new Date('2036-03-21'), endDate: new Date('2037-03-20'),
        periods: { create: [{ code: '1415-ALL', nameFa: 'کل سال', startDate: new Date('2036-03-21'), endDate: new Date('2037-03-20') }] },
      },
    });
    await expect(
      opening.stage(COMPANY, [{ accountCode: 'RECEIVABLE', debit: 100, partyId: foreignParty.id }], ACTOR, fy.id),
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

  itif('g7j-09 (P0-1 review) sibling Dr/Cr balances under one parent are NOT netted in grand totals', async () => {
    // Parent P1 with TWO children: CHILD_11 carries 100 Dr, CHILD_12 carries
    // 100 Cr. The DETAILED closing totals must keep BOTH gross amounts (the
    // parent's net roll-up is zero, but the trial-balance grand total may
    // not offset the two sides), while never double-counting parent/child.
    const parent = await prismaService.chartOfAccount.findFirstOrThrow({
      where: { companyId: COMPANY, code: 'PARENT_1' },
    });
    await prismaService.chartOfAccount.create({
      data: { code: 'CHILD_12', name: 'زیرمجموعه ۲', type: 'ASSET', companyId: COMPANY, parentId: parent.id },
    });
    const before = await reports.trialBalance(COMPANY, { level: 'all' });
    await postBalanced(new Date(), [
      { accountCode: 'CHILD_11', debit: 100, credit: 0 },   // child 1: 100 Dr
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 100 },
    ]);
    await postBalanced(new Date(), [
      { accountCode: 'CHILD_12', debit: 0, credit: 100 },   // child 2: 100 Cr
      { accountCode: 'BANK', debit: 100, credit: 0 },
    ]);
    const after = await reports.trialBalance(COMPANY, { level: 'all' });
    const dDelta = after.totals.closingDebit.minus(before.totals.closingDebit).toNumber();
    const cDelta = after.totals.closingCredit.minus(before.totals.closingCredit).toNumber();
    // Expected gross deltas: Dr side = CHILD_11's 100 + BANK's 100 = 200;
    // Cr side = CHILD_12's 100 + SALES_REVENUE's 100 = 200. The old
    // root-netted totals produced 100/100 (siblings offset to zero).
    expect(dDelta).toBe(200);
    expect(cDelta).toBe(200);
    // The parent ROW keeps its accumulated NET (the two sibling legs cancel
    // inside the parent's roll-up): after == before, zero net change.
    const parentRowBefore = before.rows.find((r) => r.accountCode === 'PARENT_1');
    const parentRow = after.rows.find((r) => r.accountCode === 'PARENT_1')!;
    expect(parentRow.closingDebit.toString()).toBe(
      (parentRowBefore?.closingDebit ?? new Prisma.Decimal(0)).toString(),
    );
    expect(parentRow.closingCredit.toString()).toBe(
      (parentRowBefore?.closingCredit ?? new Prisma.Decimal(0)).toString(),
    );
    // Level-independence is preserved with the gross method.
    const leaf = await reports.trialBalance(COMPANY, { level: 'leaf' });
    expect(leaf.totals.closingDebit.toString()).toBe(after.totals.closingDebit.toString());
    expect(leaf.totals.closingCredit.toString()).toBe(after.totals.closingCredit.toString());
  });

  itif('g7j-10 (P0-2 review) staged rows are bound to a fiscal year — no cross-year mixing', async () => {
    // Fresh fiscal years of their own (g7j-06 already consumed 1405/1406;
    // item 6 forbids staging into a year that already has an OPENING doc).
    const mkFy = async (code: string, nameFa: string, start: Date, end: Date) =>
      prismaService.fiscalYear.create({
        data: {
          companyId: COMPANY, code, nameFa, startDate: start, endDate: end,
          periods: { create: [{ code: `${code}-ALL`, nameFa: 'کل سال', startDate: start, endDate: end }] },
        },
      });
    const fy = await mkFy('1407', 'سال ۱۴۰۷', new Date('2028-03-21'), new Date('2029-03-20'));
    const fyLeft = await mkFy('1412', 'سال ۱۴۱۲', new Date('2032-03-21'), new Date('2033-03-20'));
    // Leftover row in ITS OWN year + an FY-bound row: ONLY the 1407 row generates.
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 1 }], ACTOR, fyLeft.id);
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 2000 }], ACTOR, fy.id);
    const e2 = await opening.generate(COMPANY, ACTOR, new Date('2028-04-01'));
    const lines = await prisma.journalLine.findMany({
      where: { journalEntryId: e2.id, account: { code: 'BANK' } },
    });
    const bankDebit = lines.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0));
    // Exactly the FY-bound row — the leftover stays ungenerated.
    expect(bankDebit.toNumber()).toBe(2000);
    // R-4 invariant: the leftover is AUTO-BOUND (never a null trap) and
    // still STAGED — untouched by the other year's generation.
    const leftover = await prismaService.openingBalanceEntry.findFirstOrThrow({
      where: { companyId: COMPANY, status: 'STAGED', debit: new Prisma.Decimal(1) },
    });
    expect(leftover.fiscalYearId).toBe(fyLeft.id);
  });

  itif('g7j-11 (P1-3 review) journal.post rejects cross-company partyId and analytics', async () => {
    const other = await prismaService.company.create({ data: { nameFa: `g7j-oth2-${Date.now()}`, status: 'ACTIVE' } });
    const foreignParty = await prismaService.party.create({
      data: { companyId: other.id, type: 'COMPANY', nameFa: 'پارتی خارجی' },
    });
    // Direct partyId from another company → rejected, nothing posted.
    await expect(
      postBalanced(new Date(), [
        { accountCode: 'RECEIVABLE', debit: 500, credit: 0, partyId: foreignParty.id },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 500 },
      ]),
    ).rejects.toThrow('JOURNAL_PARTY_NOT_IN_COMPANY');
    // Analytics dimension from another company → rejected too.
    await expect(
      postBalanced(new Date(), [
        {
          accountCode: 'RECEIVABLE', debit: 500, credit: 0,
          analytics: [{ dimensionType: 'CUSTOMER', dimensionId: foreignParty.id }],
        },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 500 },
      ]),
    ).rejects.toThrow('JOURNAL_ANALYTIC_NOT_IN_COMPANY');
    const count = await prismaService.journalEntry.count({ where: { companyId: COMPANY } });
    // No partial entry from the rejected posts (balanced validation happens
    // before creation, and the rejections above throw before any create).
    void count;
    await prismaService.party.delete({ where: { id: foreignParty.id } }).catch(() => undefined);
    await prismaService.company.delete({ where: { id: other.id } }).catch(() => undefined);
  });

  itif('g7j-12 (R-3 review): explicit fiscalYearId rejects an out-of-year entryDate', async () => {
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1408', nameFa: 'سال ۱۴۰۸',
        startDate: new Date('2035-03-21'), endDate: new Date('2036-03-20'),
        periods: { create: [{ code: '1408-ALL', nameFa: 'کل سال', startDate: new Date('2035-03-21'), endDate: new Date('2036-03-20') }] },
      },
    });
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 300 }], ACTOR, fy.id);
    // entryDate OUTSIDE the explicit FY → rejected (was silently accepted).
    await expect(
      opening.generate(COMPANY, ACTOR, new Date('2026-11-15'), fy.id),
    ).rejects.toThrow('OPENING_DATE_OUTSIDE_FISCAL_YEAR');
  });

  itif('g7j-13 (R-3 review): generate rejects a CLOSED fiscal year', async () => {
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1409', nameFa: 'سال ۱۴۰۹',
        startDate: new Date('2029-03-21'), endDate: new Date('2030-03-20'),
        periods: { create: [{ code: '1409-ALL', nameFa: 'کل سال', startDate: new Date('2029-03-21'), endDate: new Date('2030-03-20') }] },
      },
    });
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 400 }], ACTOR, fy.id);
    // Close AFTER staging (staging into a closed year is already rejected).
    await prismaService.fiscalYear.update({ where: { id: fy.id }, data: { status: 'CLOSED' } });
    await expect(opening.generate(COMPANY, ACTOR, new Date('2029-04-01'))).rejects.toThrow('FISCAL_YEAR_CLOSED');
  });

  itif('g7j-14 (R-3 review): two concurrent generates of one FY — exactly one wins', async () => {
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1410', nameFa: 'سال ۱۴۱۰',
        startDate: new Date('2030-03-21'), endDate: new Date('2031-03-20'),
        periods: { create: [{ code: '1410-ALL', nameFa: 'کل سال', startDate: new Date('2030-03-21'), endDate: new Date('2031-03-20') }] },
      },
    });
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 900 }], ACTOR, fy.id);
    const results = await Promise.allSettled([
      opening.generate(COMPANY, ACTOR, new Date('2030-04-01')),
      opening.generate(COMPANY, ACTOR, new Date('2030-04-01')),
    ]);
    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const conflicted = results.filter(
      (r) => r.status === 'rejected' && String((r as PromiseRejectedResult).reason?.message ?? '').includes('OPENING_ALREADY_GENERATED'),
    );
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);
  });

  itif('g7j-15 (R-4 review): stage WITHOUT fiscalYearId auto-binds to the current FY and generates', async () => {
    // Isolated company; the FY is built DYNAMICALLY around "today" so the
    // test never depends on the real calendar date it runs on.
    const c2 = await prismaService.company.create({ data: { nameFa: `g7j-c15-${Date.now()}`, status: 'ACTIVE' } });
    const C2 = c2.id;
    try {
      for (const a of [
        { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
        { code: 'OPENING_EQUITY', name: 'سرمایه', type: 'EQUITY' as const },
      ]) {
        await prismaService.chartOfAccount.create({ data: { ...a, companyId: C2 } });
      }
      await prismaService.sequence.create({
        data: { companyId: C2, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
      });
      const today = new Date();
      const fyStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 30));
      const fyEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 330));
      await prismaService.fiscalYear.create({
        data: {
          companyId: C2, code: 'CURR', nameFa: 'سال جاری', startDate: fyStart, endDate: fyEnd,
          periods: { create: [{ code: 'CURR-ALL', nameFa: 'کل سال', startDate: fyStart, endDate: fyEnd }] },
        },
      });
      // Legacy API call — no fiscalYearId.
      await opening.stage(C2, [{ accountCode: 'BANK', debit: 1234 }], ACTOR);
      const stagedRow = await prismaService.openingBalanceEntry.findFirstOrThrow({
        where: { companyId: C2, status: 'STAGED' },
      });
      expect(stagedRow.fiscalYearId).toBeTruthy(); // auto-bound, NOT null
      const entry = await opening.generate(C2, ACTOR, today);
      const bank = await prisma.journalLine.findMany({
        where: { journalEntryId: entry.id, account: { code: 'BANK' } },
      });
      expect(bank.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0)).toNumber()).toBe(1234);
    } finally {
      const lineIds = (await prismaService.journalLine.findMany({ where: { companyId: C2 }, select: { id: true } })).map((l) => l.id);
      await prismaService.journalLineAnalytic.deleteMany({ where: { journalLineId: { in: lineIds } } });
      await prismaService.journalLine.deleteMany({ where: { companyId: C2 } });
      await prismaService.journalEntry.deleteMany({ where: { companyId: C2 } });
      await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: C2 } });
      await prismaService.fiscalYear.deleteMany({ where: { companyId: C2 } });
      await prismaService.chartOfAccount.deleteMany({ where: { companyId: C2 } });
      await prismaService.sequence.deleteMany({ where: { companyId: C2 } });
      await prismaService.company.delete({ where: { id: C2 } }).catch(() => undefined);
    }
  });

  itif('g7j-17 (R3-1/R3-6 review): staging/assigning into a year that ALREADY has an OPENING doc is rejected', async () => {
    // FY1405 already generated its OPENING entry (g7j-06).
    const fy1405 = await prismaService.fiscalYear.findFirstOrThrow({
      where: { companyId: COMPANY, code: '1405' },
    });
    await expect(
      opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 42 }], ACTOR, fy1405.id),
    ).rejects.toThrow('OPENING_FISCAL_YEAR_ALREADY_GENERATED');
    // A REAL assignment attempt (staged row + explicit selection) into the
    // generated year must hit the same guard.
    const row = await prismaService.openingBalanceEntry.create({
      data: { companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(42), status: 'STAGED', createdBy: ACTOR.id },
    });
    await expect(
      opening.assignTo(COMPANY, fy1405.id, ACTOR, { rowIds: [row.id] }),
    ).rejects.toThrow('OPENING_FISCAL_YEAR_ALREADY_GENERATED');
    await expect(opening.assignTo(COMPANY, fy1405.id, ACTOR, { rowIds: [] })).rejects.toThrow(
      'OPENING_ROW_SELECTION_REQUIRED',
    );
    await prismaService.openingBalanceEntry.delete({ where: { id: row.id } });
    // Nothing was written.
    const count = await prismaService.openingBalanceEntry.count({
      where: { companyId: COMPANY, status: 'STAGED', fiscalYearId: fy1405.id },
    });
    expect(count).toBe(0);
  });

  itif('g7j-18 (R3-2 review): stage with a calendar but NO open FY containing today is an explicit error', async () => {
    // Isolated company whose ONLY fiscal year does not contain today.
    const c2 = await prismaService.company.create({ data: { nameFa: `g7j-c18-${Date.now()}`, status: 'ACTIVE' } });
    const C2 = c2.id;
    try {
      await prismaService.chartOfAccount.create({ data: { code: 'BANK', name: 'بانک', type: 'ASSET', companyId: C2 } });
      await prismaService.fiscalYear.create({
        data: {
          companyId: C2, code: 'FAR', nameFa: 'سال دور',
          startDate: new Date('2029-03-21'), endDate: new Date('2030-03-20'),
        },
      });
      // A calendar EXISTS → legacy null-batch is forbidden; the caller must
      // pass fiscalYearId explicitly.
      await expect(opening.stage(C2, [{ accountCode: 'BANK', debit: 10 }], ACTOR)).rejects.toThrow(
        'OPENING_FISCAL_YEAR_REQUIRED',
      );
    } finally {
      await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: C2 } });
      await prismaService.fiscalYear.deleteMany({ where: { companyId: C2 } });
      await prismaService.chartOfAccount.deleteMany({ where: { companyId: C2 } });
      await prismaService.company.delete({ where: { id: C2 } }).catch(() => undefined);
    }
  });

  itif('g7j-19 (R3-5 review): the LAST calendar day of a fiscal year belongs to the year (DATE vs TIMESTAMP)', async () => {
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1413', nameFa: 'سال ۱۴۱۳',
        startDate: new Date('2033-03-21'), endDate: new Date('2034-03-20'),
        periods: { create: [{ code: '1413-ALL', nameFa: 'کل سال', startDate: new Date('2033-03-21'), endDate: new Date('2034-03-20') }] },
      },
    });
    await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 800 }], ACTOR, fy.id);
    // Noon on the LAST calendar day of the FY — a DATE column means the whole
    // day belongs to the year.
    const entry = await opening.generate(COMPANY, ACTOR, new Date('2034-03-20T12:00:00Z'), fy.id);
    expect(entry.documentType).toBe('OPENING');
    // The same calendar-day policy in assertOpenPeriod: posting at noon on
    // the last day of an OPEN year/period must NOT be PERIOD_NOT_FOUND.
    const posted = await prismaService.$transaction((tx) =>
      journal.post(tx, {
        companyId: COMPANY,
        entryDate: new Date('2036-03-20T12:00:00Z'), // last day of FY1408 window
        journalCode: 'OPERATIONAL',
        documentType: 'G7J_TEST',
        lines: [
          { accountCode: 'BANK', debit: 5, credit: 0 },
          { accountCode: 'SALES_REVENUE', debit: 0, credit: 5 },
        ] as never,
        createdBy: ACTOR.id,
      }),
    );
    expect(posted.status).toBe('POSTED');
  });

  itif('g7j-21 (R4-4/5/6 review): two CONCURRENT generates at last-day-noon → exactly ONE POSTED entry', async () => {
    // Two INDEPENDENT Prisma connections — the real race, not a shared client.
    const { PrismaService: S } = await import('../prisma/prisma.service');
    const connB = new S();
    await connB.$connect();
    try {
      const fy = await prismaService.fiscalYear.create({
        data: {
          companyId: COMPANY, code: '1416', nameFa: 'سال ۱۴۱۶',
          startDate: new Date('2037-03-21'), endDate: new Date('2038-03-20'),
          periods: { create: [{ code: '1416-ALL', nameFa: 'کل سال', startDate: new Date('2037-03-21'), endDate: new Date('2038-03-20') }] },
        },
      });
      const openingB = new OpeningBalanceService(
        connB as never,
        new JournalService(connB as never, new SequencesService(connB as never, new AuditService(connB as never))),
        new SequencesService(connB as never, new AuditService(connB as never)),
        new AuditService(connB as never),
      );
      await opening.stage(COMPANY, [{ accountCode: 'BANK', debit: 700 }], ACTOR, fy.id);
      const noon = new Date('2038-03-20T12:00:00Z'); // LAST calendar day, midday
      const results = await Promise.allSettled([
        opening.generate(COMPANY, ACTOR, noon),
        openingB.generate(COMPANY, ACTOR, noon),
      ]);
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      // Exactly ONE POSTED OPENING entry may exist for the fiscal year.
      const posted = await prismaService.journalEntry.count({
        where: { companyId: COMPANY, documentType: 'OPENING', status: 'POSTED', entryDate: { gte: new Date('2037-03-21'), lt: new Date('2038-03-21') } },
      });
      expect(posted).toBe(1);
      expect(succeeded).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(String((rejected[0] as PromiseRejectedResult).reason)).toContain('OPENING_ALREADY_GENERATED');
    } finally {
      await connB.$disconnect();
    }
  });

  itif('g7j-22 (R4-10 review): stage auto-bind recognizes TODAY at noon on an FY last day', async () => {
    // Isolated company whose fiscal year ENDS TODAY — the auto-bind anchor
    // must use the calendar DAY, not midnight-vs-timestamp comparison.
    const c2 = await prismaService.company.create({ data: { nameFa: `g7j-c22-${Date.now()}`, status: 'ACTIVE' } });
    const C2 = c2.id;
    try {
      await prismaService.chartOfAccount.create({ data: { code: 'BANK', name: 'بانک', type: 'ASSET', companyId: C2 } });
      const now = new Date();
      const fyStart = new Date(now.getTime() - 300 * 86_400_000);
      const fyEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); // TODAY (midnight DATE)
      await prismaService.fiscalYear.create({
        data: {
          companyId: C2, code: 'LASTDAY', nameFa: 'سال تمام‌شده امروز', startDate: fyStart, endDate: fyEnd,
          periods: { create: [{ code: 'LASTDAY-ALL', nameFa: 'کل سال', startDate: fyStart, endDate: fyEnd }] },
        },
      });
      // Runs at some hour of TODAY — noon-like timestamps must still match.
      await opening.stage(C2, [{ accountCode: 'BANK', debit: 99 }], ACTOR);
      const row = await prismaService.openingBalanceEntry.findFirstOrThrow({
        where: { companyId: C2, status: 'STAGED' },
      });
      expect(row.fiscalYearId).toBeTruthy(); // bound, not OPENING_FISCAL_YEAR_REQUIRED
    } finally {
      await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: C2 } });
      await prismaService.fiscalYear.deleteMany({ where: { companyId: C2 } });
      await prismaService.chartOfAccount.deleteMany({ where: { companyId: C2 } });
      await prismaService.company.delete({ where: { id: C2 } }).catch(() => undefined);
    }
  });

  itif('g7j-23 (R4-11 review): stage/assign cannot slip rows in once the OPENING doc exists', async () => {
    // Deterministic interleaving with TWO connections: connection B runs
    // generate's critical section (advisory lock + uncommitted OPENING doc,
    // held open by an in-tx delay). Connection A's stage must BLOCK on the
    // lock (insert nothing) and, once B commits, FAIL the re-check.
    const { PrismaService: S } = await import('../prisma/prisma.service');
    const connB = new S();
    await connB.$connect();
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1417', nameFa: 'سال ۱۴۱۷',
        startDate: new Date('2038-03-21'), endDate: new Date('2039-03-20'),
        periods: { create: [{ code: '1417-ALL', nameFa: 'کل سال', startDate: new Date('2038-03-21'), endDate: new Date('2039-03-20') }] },
      },
    });
    const entryNumber = `JE-R4-${Date.now()}`;
    try {
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const txDone = connB.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COMPANY}))`;
        await tx.journalEntry.create({
          data: {
            companyId: COMPANY,
            entryNumber,
            entryDate: new Date('2038-04-01T12:00:00Z'),
            journalCode: 'OPENING',
            documentType: 'OPENING',
            status: 'POSTED',
            postedAt: new Date(),
            lines: { create: [] },
          },
        });
        await sleep(600); // hold the lock while A's stage reaches it
      });
      await sleep(250); // B's entry exists (uncommitted), lock held
      // A stages CONCURRENTLY — it blocks on the lock, inserts nothing.
      let inFlightError: unknown = null;
      const inFlight = opening
        .stage(COMPANY, [{ accountCode: 'BANK', debit: 5 }], ACTOR, fy.id)
        .catch((e: unknown) => {
          inFlightError = e;
          return null;
        });
      await sleep(400); // A is now parked on the advisory lock
      const slipped = await prismaService.openingBalanceEntry.count({
        where: { companyId: COMPANY, status: 'STAGED', fiscalYearId: fy.id },
      });
      expect(slipped).toBe(0); // nothing slipped in while blocked
      await txDone; // commit → releases the lock
      await inFlight; // A's blocked stage re-checks the COMMITTED doc
      expect(String(inFlightError)).toContain('OPENING_FISCAL_YEAR_ALREADY_GENERATED');
      // Assign is equally guarded after the doc exists.
      const row = await prismaService.openingBalanceEntry.create({
        data: { companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(7), status: 'STAGED', createdBy: ACTOR.id },
      });
      await expect(
        opening.assignTo(COMPANY, fy.id, ACTOR, { rowIds: [row.id] }),
      ).rejects.toThrow('OPENING_FISCAL_YEAR_ALREADY_GENERATED');
      await prismaService.openingBalanceEntry.delete({ where: { id: row.id } });
      const staged = await prismaService.openingBalanceEntry.count({
        where: { companyId: COMPANY, status: 'STAGED', fiscalYearId: fy.id },
      });
      expect(staged).toBe(0);
    } finally {
      await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: COMPANY, fiscalYearId: fy.id } });
      await prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY, entryNumber } });
      await prismaService.fiscalYear.deleteMany({ where: { id: fy.id } });
      await connB.$disconnect();
    }
  }, 30_000);

  itif('g7j-24 (R4-12 review): mutation assignment REQUIRES an explicit row selection', async () => {
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1418', nameFa: 'سال ۱۴۱۸',
        startDate: new Date('2039-03-21'), endDate: new Date('2040-03-20'),
        periods: { create: [{ code: '1418-ALL', nameFa: 'کل سال', startDate: new Date('2039-03-21'), endDate: new Date('2040-03-20') }] },
      },
    });
    await prismaService.openingBalanceEntry.create({
      data: { companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(3), status: 'STAGED', createdBy: ACTOR.id },
    });
    // No rowIds in MUTATION mode → rejected (blind bulk assignment forbidden).
    await expect(opening.assignTo(COMPANY, fy.id, ACTOR)).rejects.toThrow('OPENING_ROW_SELECTION_REQUIRED');
    // Preview without rowIds stays allowed (survey of unassigned rows).
    const preview = (await opening.assignTo(COMPANY, fy.id, ACTOR, { preview: true })) as {
      count: number;
    };
    expect(preview.count).toBe(1);
  });

  itif('g7j-25 (R4-13 review): concurrent overlapping assignments audit ONLY their actually-moved rows', async () => {
    const { PrismaService: S } = await import('../prisma/prisma.service');
    const connB = new S();
    await connB.$connect();
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1419', nameFa: 'سال ۱۴۱۹',
        startDate: new Date('2040-03-21'), endDate: new Date('2041-03-20'),
        periods: { create: [{ code: '1419-ALL', nameFa: 'کل سال', startDate: new Date('2040-03-21'), endDate: new Date('2040-03-21') }] },
      },
    });
    const openingB = new OpeningBalanceService(
      connB as never,
      new JournalService(connB as never, new SequencesService(connB as never, new AuditService(connB as never))),
      new SequencesService(connB as never, new AuditService(connB as never)),
      new AuditService(connB as never),
    );
    try {
      const rows: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        const r = await prismaService.openingBalanceEntry.create({
          data: { companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(i * 10), status: 'STAGED', createdBy: ACTOR.id },
        });
        rows.push(r.id);
      }
      // Overlapping selections: A takes r1+r2, B takes r2+r3.
      const [resA, resB] = (await Promise.all([
        opening.assignTo(COMPANY, fy.id, ACTOR, { rowIds: [rows[0], rows[1]] }),
        openingB.assignTo(COMPANY, fy.id, ACTOR, { rowIds: [rows[1], rows[2]] }),
      ])) as [number, number];
      expect(resA + resB).toBe(3); // three distinct rows moved in total
      const audits = await prismaService.auditLog.findMany({
        where: { entityType: 'opening_balance', action: 'ASSIGN', companyId: COMPANY },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      const claimed = audits.flatMap((a) => (a.newValues as { rowIds: string[] }).rowIds);
      // The two audits must be DISJOINT and cover exactly the moved rows —
      // no row claimed by both requests.
      expect(new Set(claimed).size).toBe(claimed.length);
      expect(new Set(claimed)).toEqual(new Set(rows));
    } finally {
      await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: COMPANY, fiscalYearId: fy.id } });
      await prismaService.fiscalYear.deleteMany({ where: { id: fy.id } });
      await connB.$disconnect();
    }
  });

  itif('g7j-20 (R3-1 review): assignTo is SELECTIVE and PREVIEWABLE with row-level audit', async () => {
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1414', nameFa: 'سال ۱۴۱۴',
        startDate: new Date('2034-03-21'), endDate: new Date('2035-03-20'),
        periods: { create: [{ code: '1414-ALL', nameFa: 'کل سال', startDate: new Date('2034-03-21'), endDate: new Date('2035-03-20') }] },
      },
    });
    const row1 = await prismaService.openingBalanceEntry.create({
      data: { companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(11), status: 'STAGED', createdBy: ACTOR.id },
    });
    const row2 = await prismaService.openingBalanceEntry.create({
      data: { companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(22), status: 'STAGED', createdBy: ACTOR.id },
    });
    // Preview mutates NOTHING.
    const preview = (await opening.assignTo(COMPANY, fy.id, ACTOR, {
      rowIds: [row1.id],
      preview: true,
    })) as { count: number; rows: Array<{ id: string }> };
    expect(preview.rows.map((r) => r.id)).toEqual([row1.id]);
    expect(preview.count).toBe(1);
    // Selective: only row1 moves; row2 stays unassigned.
    const assigned = await opening.assignTo(COMPANY, fy.id, ACTOR, { rowIds: [row1.id] });
    expect(assigned).toBe(1);
    expect((await prismaService.openingBalanceEntry.findUniqueOrThrow({ where: { id: row1.id } })).fiscalYearId).toBe(fy.id);
    expect((await prismaService.openingBalanceEntry.findUniqueOrThrow({ where: { id: row2.id } })).fiscalYearId).toBeNull();
    // Detailed audit: the id list is recorded.
    const audits = await prismaService.auditLog.findMany({
      where: { entityType: 'opening_balance', action: 'ASSIGN', companyId: COMPANY },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    const newValues = audits[0]?.newValues as { rowIds?: string[] };
    expect(newValues.rowIds).toEqual([row1.id]);
  });

  it('g7j-16 (R-4 review): legacy NULL-staged rows are safely assigned — never deleted', async () => {
    // Simulate 80502ae-era data: an unassigned STAGED row.
    const legacy = await prismaService.openingBalanceEntry.create({
      data: {
        companyId: COMPANY, accountCode: 'BANK', debit: new Prisma.Decimal(555),
        status: 'STAGED', createdBy: ACTOR.id,
      },
    });
    const fy = await prismaService.fiscalYear.create({
      data: {
        companyId: COMPANY, code: '1411', nameFa: 'سال ۱۴۱۱',
        startDate: new Date('2031-03-21'), endDate: new Date('2032-03-20'),
        periods: { create: [{ code: '1411-ALL', nameFa: 'کل سال', startDate: new Date('2031-03-21'), endDate: new Date('2032-03-20') }] },
      },
    });
    const assigned = await opening.assignTo(COMPANY, fy.id, ACTOR, { rowIds: [legacy.id] });
    expect(assigned).toBe(1);
    const row = await prismaService.openingBalanceEntry.findUniqueOrThrow({ where: { id: legacy.id } });
    expect(row.fiscalYearId).toBe(fy.id); // preserved, not deleted
    const entry = await opening.generate(COMPANY, ACTOR, new Date('2031-04-01'));
    const bank = await prisma.journalLine.findMany({
      where: { journalEntryId: entry.id, account: { code: 'BANK' } },
    });
    expect(bank.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0)).toNumber()).toBe(555);
  });
});
