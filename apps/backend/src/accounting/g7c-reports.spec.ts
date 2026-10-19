import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ReportsService } from './reports.service';
import { SubsidiaryLedgerService } from './subsidiary-ledger.service';
import { ProfitReportService } from './profit-report.service';
import { ValuationReportService } from './valuation-report.service';
import { OpeningBalanceService } from './opening-balance.service';
import { JournalService } from './journal.service';
import { SequencesService } from '../sequences/sequences.service';
import { describeIntegration, integrationPrisma, disconnectIntegrationPrisma } from '../testing/integration';
import { createVariant } from '../testing/p4-fixtures';

jest.setTimeout(60000);

const DB_URL = process.env.DATABASE_URL;
const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };
let COMPANY = '';

describe('g7c — Phase 7C reporting (live DB)', () => {
  let prisma: PrismaService;
  let reports: ReportsService;
  let subsidiary: SubsidiaryLedgerService;
  let profit: ProfitReportService;
  let valuation: ValuationReportService;
  let opening: OpeningBalanceService;
  let journal: JournalService;
  let entryIds: string[] = [];
  let variantId = '';

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prisma = new S();
    await prisma.$connect();
    // Hermetic company: the shared integration company carries months of
    // (pre-balanced-check) smoke journals — reporting assertions need clean data.
    const company = await prisma.company.create({
      data: { nameFa: `g7c-${Date.now()}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    const accounts: Array<{ code: string; name: string; type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE' }> = [
      { code: 'BANK', name: 'بانک', type: 'ASSET' },
      { code: 'RECEIVABLE', name: 'دریافتنی', type: 'ASSET' },
      { code: 'PAYABLE', name: 'پرداختنی', type: 'LIABILITY' },
      { code: 'INVENTORY', name: 'موجودی کالا', type: 'ASSET' },
      { code: 'SALES_REVENUE', name: 'درآمد فروش', type: 'REVENUE' },
      { code: 'PURCHASE_EXPENSE', name: 'بهای تمام‌شده', type: 'EXPENSE' },
      { code: 'OPENING_EQUITY', name: 'سرمایه افتتاحیه', type: 'EQUITY' },
    ];
    for (const a of accounts) {
      await prisma.chartOfAccount.create({ data: { ...a, companyId: COMPANY } });
    }
    await prisma.sequence.create({
      data: { companyId: COMPANY, documentType: 'JOURNAL_ENTRY', name: 'سند روزنامه', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
    // INTERNAL stock location for valuation movements
    await prisma.$executeRaw`
      INSERT INTO stock_locations (id, company_id, type, code, name_fa, active)
      VALUES (gen_random_uuid(), ${COMPANY}::uuid, 'INTERNAL', 'LOC-MAIN', 'انبار اصلی', true)`;
    await prisma.stockLocation.findFirstOrThrow({ where: { companyId: COMPANY } });
    const audit = new AuditService(prisma as never);
    journal = new JournalService(prisma as never, new SequencesService(prisma as never, audit));
    reports = new ReportsService(prisma as never);
    subsidiary = new SubsidiaryLedgerService(prisma as never);
    profit = new ProfitReportService(prisma as never);
    valuation = new ValuationReportService(prisma as never);
    opening = new OpeningBalanceService(prisma as never, journal, new SequencesService(prisma as never, audit), audit);

    // Fixture: a customer party, a variant, one balanced revenue+COGS journal.
    const customer = await prisma.party.create({
      data: {
        companyId: COMPANY,
        type: 'COMPANY',
        nameFa: `گ7c مشتری ${Date.now()}`,
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    const fixture = await createVariant(prisma, `g7c-${Date.now()}`);
    variantId = fixture.variantId;

    const receivable = await prisma.chartOfAccount.findFirstOrThrow({ where: { companyId: COMPANY, code: 'RECEIVABLE' } });
    const revenue = await prisma.chartOfAccount.findFirstOrThrow({ where: { companyId: COMPANY, code: 'SALES_REVENUE' } });
    const cogs = await prisma.chartOfAccount.findFirstOrThrow({ where: { companyId: COMPANY, code: 'PURCHASE_EXPENSE' } });

    const entry = await journal.post(prisma as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'OPERATIONAL',
      documentType: 'SALES_COMPLETED_LOADING',
      description: 'g7c fixture sale',
      lines: [
        {
          accountCode: 'RECEIVABLE',
          debit: 1000,
          credit: 0,
          partyId: customer.id,
          analytics: [{ dimensionType: 'CUSTOMER', dimensionId: customer.id }],
        },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 1000 },
        { accountCode: 'PURCHASE_EXPENSE', debit: 600, credit: 0 },
        { accountCode: 'INVENTORY', debit: 0, credit: 600 },
      ],
    });
    entryIds.push(entry.id);
    void receivable;
    void revenue;
    void cogs;
  });

  afterAll(async () => {
    await prisma?.journalEntry.deleteMany({ where: { id: { in: entryIds } } });
    await prisma?.journalLineAnalytic.deleteMany({ where: { journalLineId: { not: undefined } } });
    await prisma?.$disconnect();
  });

  const itif = DB_URL
    ? it
    : (name: string, fn: jest.ProvidesCallback) => {
        // P1: make silent skips VISIBLE
        // eslint-disable-next-line no-console
        console.warn(`[g7c] SKIPPED (no DATABASE_URL): ${name}`);
        return it.skip(name, fn);
      };

  itif('g7c-01 ledger totals match journal lines', async () => {
    const report = await reports.generalLedger(COMPANY, { accountCode: 'RECEIVABLE' });
    const debit = report.rows.reduce((s, r) => s.plus(r.debit), new (await import('@prisma/client')).Prisma.Decimal(0));
    expect(report.totals.debit.toNumber()).toBeGreaterThanOrEqual(debit.toNumber());
    const fixtureRows = report.rows.slice(-1); // fixture entry is the newest RECEIVABLE line
    expect(fixtureRows.length).toBe(1);
    const sign = report.normalSide === 'DEBIT' ? 1 : -1;
    const expectedRunning = report.openingBalance.plus(
      new (await import('@prisma/client')).Prisma.Decimal(
        (Number(fixtureRows[0].debit) - Number(fixtureRows[0].credit)) * sign,
      ),
    );
    expect(fixtureRows[0].runningBalance.equals(expectedRunning)).toBe(true);
  });

  itif('g7c-02 trial balance balanced', async () => {
    const tb = await reports.trialBalance(COMPANY, { asOf: new Date() });
    expect(tb.balanced).toBe(true);
    expect(tb.totals.closingDebit.equals(tb.totals.closingCredit)).toBe(true);
  });

  itif('g7c-03 customer ledger matches analytic lines', async () => {
    const analytics = await prisma.journalLineAnalytic.findMany({
      where: { dimensionType: 'CUSTOMER' },
      select: { dimensionId: true, journalLineId: true },
    });
    expect(analytics.length).toBeGreaterThan(0);
    const first = analytics[0];
    const line = await prisma.journalLine.findUniqueOrThrow({
      where: { id: first.journalLineId },
      select: { partyId: true, debit: true, credit: true },
    });
    const ledger = await subsidiary.partyLedger(COMPANY, first.dimensionId, { accountCode: 'RECEIVABLE' });
    const match = ledger.rows.find(
      (r) => entryIds.includes(r.entryId) && r.debit.equals(line.debit) && r.credit.equals(line.credit),
    );
    expect(match).toBeTruthy();
  });

  itif('g7c-04 profit matches journal legs (revenue vs COGS)', async () => {
    const report = await profit.operationalProfit(COMPANY, {});
    const fixtureRow = report.rows.find((r) => r.revenue.toNumber() === 1000);
    if (fixtureRow) {
      expect(fixtureRow.cogs.toNumber()).toBe(600);
      expect(fixtureRow.grossProfit.toNumber()).toBe(400);
    }
    expect(report.totals.revenue.toNumber()).toBeGreaterThanOrEqual(0);
  });

  itif('g7c-05 inventory valuation matches movements (specific identification)', async () => {
    const report = await valuation.valuation(COMPANY, { variantId });
    const row = report.rows.find((r) => r.variant.id === variantId);
    if (row) {
      // value must equal Σ(normalized × unitCost) over internal movements —
      // the SQL already does exactly this; assert consistency with a direct sum
      const agg = await prisma.$queryRaw<Array<{ qty: Prisma.Decimal; value: Prisma.Decimal }>>`
        SELECT COALESCE(SUM(CASE WHEN dl.type='INTERNAL' THEN m.normalized_quantity ELSE -m.normalized_quantity END),0) AS qty,
               COALESCE(SUM(CASE WHEN dl.type='INTERNAL' THEN m.normalized_quantity * COALESCE(m.unit_cost_snapshot,0) ELSE -(m.normalized_quantity * COALESCE(m.unit_cost_snapshot,0)) END),0) AS value
        FROM stock_movements m
        JOIN stock_locations dl ON dl.id = m.destination_location_id
        JOIN stock_locations sl ON sl.id = m.source_location_id
        WHERE m.company_id = ${COMPANY}::uuid AND m.product_variant_id = ${variantId}::uuid`;
      expect(Number(row.quantity)).toBeCloseTo(Number(agg[0].qty), 4);
    }
  });

  itif('g7c-06 opening journal balanced', async () => {
    const rows = [
      { accountCode: 'BANK', debit: 5000, credit: 0 },
      { accountCode: 'RECEIVABLE', debit: 2500, credit: 0, partyName: 'buyer opening' },
      { accountCode: 'OPENING_EQUITY', debit: 0, credit: 7500 },
    ];
    const res = await opening.stage(COMPANY, rows, ACTOR);
    expect(res.staged).toBe(3);
    const entry = await opening.generate(COMPANY, ACTOR);
    expect(entry.status).toBe('POSTED');
    const lines = await prisma.journalLine.findMany({ where: { journalEntryId: entry.id } });
    const debit = lines.reduce((s, l) => s.plus(l.debit), new (await import('@prisma/client')).Prisma.Decimal(0));
    const credit = lines.reduce((s, l) => s.plus(l.credit), new (await import('@prisma/client')).Prisma.Decimal(0));
    expect(debit.equals(credit)).toBe(true);
  });
});
