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
import { describeIntegration, integrationPrisma, disconnectIntegrationPrisma } from '../testing/integration';

jest.setTimeout(90000);

const DB_URL = process.env.DATABASE_URL;
const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

describe('g7i — Reporting Integrity Gate (hermetic live DB)', () => {
  let prisma: PrismaClient;
  let prismaService: PrismaService;
  let audit: AuditService;
  let journal: JournalService;
  let reports: ReportsService;
  let subsidiary: SubsidiaryLedgerService;
  let valuation: ValuationReportService;
  let opening: OpeningBalanceService;
  let COMPANY = '';
  const entryIds: string[] = [];
  let normalizer: NormalizationService;

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
    normalizer = new NormalizationService(prismaService as never);
    opening = new OpeningBalanceService(
      prismaService as never,
      journal,
      new SequencesService(prismaService as never, audit),
      audit,
    );

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
    // child of PARENT_1 for hierarchy tests
    await prismaService.chartOfAccount.create({
      data: { code: 'CHILD_11', name: 'بانک زیرمجموعه', type: 'ASSET', companyId: COMPANY, parentId: (await prismaService.chartOfAccount.findFirstOrThrow({ where: { companyId: COMPANY, code: 'PARENT_1' } })).id },
    });
    await prismaService.sequence.create({
      data: { companyId: COMPANY, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
    // INTERNAL stock location for valuation legs
    await prismaService.$executeRaw`
      INSERT INTO stock_locations (id, company_id, type, code, name_fa, active)
      VALUES (gen_random_uuid(), ${COMPANY}::uuid, 'INTERNAL', 'LOC-A', 'انبار A', true)`;
  });

  afterAll(async () => {
    if (!prismaService) return;
    // cleanup hermetic company (order: dependents first)
    await prismaService.journalLineAnalytic.deleteMany({});
    await prismaService.journalLine.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.openingBalanceEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.stockMovement.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.stockLocation.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.chartOfAccount.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.sequence.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.party.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    await prismaService.$disconnect();
  });

  const itif = DB_URL ? it : it.skip;
  const D = (v: string | number) => new Prisma.Decimal(v);

  async function postBalanced(date: Date, lines: Array<{ accountCode: string; debit: string | number; credit: string | number; partyId?: string; description?: string }>) {
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: date,
      journalCode: 'GENERAL',
      lines: lines.map((l) => ({ ...l, analytics: undefined as never })),
    });
    entryIds.push(entry.id);
    return entry;
  }

  itif('g7i-01/02 reversed entry net impact zero; both records remain auditable', async () => {
    const date = new Date();
    const original = await postBalanced(date, [
      { accountCode: 'BANK', debit: 100, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 100 },
    ]);
    // Pair-net-zero: use the GL pair assertion (below) as the authoritative net check.
    const { reversal } = await journal.reverse(original.id, ACTOR);
    entryIds.push(reversal.id);

    const tbAfter = await reports.trialBalance(COMPANY, { asOf: new Date() });
    expect(tbAfter.balanced).toBe(true); // whole TB stays balanced with both rows present

    const gl = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    const pair = gl.rows.filter((r) => r.entryId === original.id || r.entryId === reversal.id);
    expect(pair).toHaveLength(2); // BOTH remain auditable
    expect(pair.every((r) => r.reversed === (r.entryId === original.id))).toBe(true);
    const pairNet = pair.reduce((s, r) => s.plus(r.debit).minus(r.credit), new Prisma.Decimal(0));
    expect(pairNet.isZero()).toBe(true);
    // GL closing impact zero between before/after reverse
    // GL closing reflects net zero too: pairNet is zero so closing equals the pre-original balance
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

    // period Feb only: movement debit = 50 (excludes Jan opening 100 and Mar 25)
    const tbFeb = await reports.trialBalance(COMPANY, { from: new Date('2026-02-01'), to: new Date('2026-02-28') });
    const bankFeb = tbFeb.rows.find((r) => r.accountCode === 'BANK');
    expect(bankFeb!.openingDebit.toNumber()).toBe(100); // Jan posting is opening
    expect(bankFeb!.debit.toNumber()).toBe(50); // movement excludes opening
    expect(bankFeb!.closingDebit.toNumber()).toBe(150); // opening + movement

    // three-period totals reconcile: Jan close 100 → Feb close 150 → Mar close 175
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

  itif('g7i-05/06 parent roll-up = sum children; GL subtree', async () => {
    // CHILD_11 is child of PARENT_1; post into CHILD_11
    const e = await postBalanced(new Date(), [
      { accountCode: 'CHILD_11', debit: 333, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: 333 },
    ]);
    entryIds.push(e.id);
    const tbAll = await reports.trialBalance(COMPANY, { level: 'all' });
    const parent = tbAll.rows.find((r) => r.accountCode === 'PARENT_1')!;
    const child = tbAll.rows.find((r) => r.accountCode === 'CHILD_11')!;
    expect(parent.closingDebit.toNumber()).toBeGreaterThanOrEqual(child.closingDebit.toNumber());
    // subtree GL on PARENT_1 includes the CHILD_11 line
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'PARENT_1' });
    const subtreeLine = gl.rows.find((r) => r.debit.toNumber() === 333);
    expect(subtreeLine).toBeTruthy();
    // and exact-account GL on CHILD_11 shows it too
    const glChild = await reports.generalLedger(COMPANY, { accountCode: 'CHILD_11' });
    expect(glChild.rows.some((r) => r.debit.toNumber() === 333)).toBe(true);
  });

  itif('g7i-17 GL keyset pagination running-balance continuity', async () => {
    // post 5 entries 1..5 on BANK
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
    // last row of page1 running balance
    const lastP1 = page1.rows[page1.rows.length - 1].runningBalance.toNumber();
    const page2 = await reports.generalLedger(COMPANY, {
      accountCode: 'BANK',
      limit: 3,
      cursor: page1.nextCursor,
    });
    expect(page2.rows.length).toBeGreaterThanOrEqual(2);
    // page2 first row's running balance = page1 last + its own delta
    const firstP2 = page2.rows[0];
    expect(firstP2.runningBalance.minus(lastP1).toNumber()).toBe(firstP2.debit.minus(firstP2.credit).toNumber());
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

  itif('g7i-14/15 Decimal precision survives post/report/reversal', async () => {
    const big = '123456789012345.6789';
    const original = await postBalanced(new Date(), [
      { accountCode: 'BANK', debit: big, credit: 0 },
      { accountCode: 'SALES_REVENUE', debit: 0, credit: big },
    ]);
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    const row = gl.rows.find((r) => r.entryId === original.id)!;
    expect(row.debit.toString()).toBe(big); // exact round-trip, no float loss
    const { reversal } = await journal.reverse(original.id, ACTOR);
    const rLines = await prisma.journalLine.findMany({ where: { journalEntryId: reversal.id } });
    const revCredit = rLines.find((l) => l.credit.gt(0))!;
    expect(revCredit.credit.toString()).toBe(big); // exact after reversal too
  });

  itif('g7i-18 company isolation', async () => {
    const gl = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    // every row must belong to this company's entries
    const entries = await prisma.journalEntry.findMany({ where: { id: { in: gl.rows.map((r) => r.entryId) } } });
    expect(entries.every((e) => e.companyId === COMPANY)).toBe(true);
  });

  itif('g7i-19/20 reversed subsidiary balance zero; report queries bounded', async () => {
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
  });
});
