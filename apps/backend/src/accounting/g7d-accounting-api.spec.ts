import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from './journal.service';
import { ReportsService } from './reports.service';
import { SubsidiaryLedgerService } from './subsidiary-ledger.service';
import { AccountingEventService } from './accounting-event.service';
import { ProfitReportService } from './profit-report.service';
import { FiscalYearService } from './fiscal-year.service';
import { SequencesService } from '../sequences/sequences.service';
import { TEST_INTEGRATION, integrationPrisma, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(90000);

const DB_URL = process.env.DATABASE_URL;

// guard only in real integration runs — unit runs must not touch the DB
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

describe('g7d — Phase 7D accounting API (hermetic live DB)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let journal: JournalService;
  let reports: ReportsService;
  let subsidiary: SubsidiaryLedgerService;
  let events: AccountingEventService;
  let profit: ProfitReportService;
  let fiscal: FiscalYearService;
  let COMPANY = '';
  const myEntryIds: string[] = [];
  const myFiscalYearIds: string[] = [];

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prismaService = new S();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    const audit = new AuditService(prismaService as never);
    journal = new JournalService(prismaService as never, new SequencesService(prismaService as never, audit));
    reports = new ReportsService(prismaService as never);
    subsidiary = new SubsidiaryLedgerService(prismaService as never);
    events = new AccountingEventService(prismaService as never, journal);
    profit = new ProfitReportService(prismaService as never);
    fiscal = new FiscalYearService(prismaService as never, audit);

    const company = await prismaService.company.create({
      data: { nameFa: `g7d-${Date.now()}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    for (const a of [
      { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
      { code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' as const },
      { code: 'RECEIVABLE', name: 'دریافتنی', type: 'ASSET' as const },
      { code: 'PAYABLE', name: 'پرداختنی', type: 'LIABILITY' as const },
      { code: 'INVENTORY', name: 'موجودی', type: 'ASSET' as const },
      { code: 'PURCHASE_EXPENSE', name: 'بهای تمام‌شده', type: 'EXPENSE' as const },
    ]) {
      await prismaService.chartOfAccount.create({ data: { ...a, companyId: COMPANY } });
    }
    await prismaService.sequence.create({
      data: { companyId: COMPANY, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
  });

  const itif = TEST_INTEGRATION && DB_URL
    ? it
    : (name: string, fn: jest.ProvidesCallback) => {
        // eslint-disable-next-line no-console
        console.warn(`[g7d] SKIPPED (no DATABASE_URL): ${name}`);
        return it.skip(name, fn);
      };

  afterAll(async () => {
    if (!prismaService || !COMPANY) {
      if (prismaService) await prismaService.$disconnect();
      return;
    }
    // scoped cleanup, dependency-safe order, loud failures
    const failures: string[] = [];
    try {
      const steps: Array<[string, () => Promise<unknown>]> = [
        ['journalLineAnalytic', () =>
          prismaService.journalLineAnalytic.deleteMany({ where: { journalLine: { companyId: COMPANY } } })],
        ['journalLine', () => prismaService.journalLine.deleteMany({ where: { companyId: COMPANY } })],
        ['accountingEvent', () => prismaService.accountingEvent.deleteMany({ where: { companyId: COMPANY } })],
        ['journalEntry', () => prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY } })],
        ['fiscalPeriod', async () => {
          for (const id of myFiscalYearIds) {
            await prismaService.fiscalPeriod.deleteMany({ where: { fiscalYearId: id } });
            await prismaService.fiscalYear.deleteMany({ where: { id } });
          }
        }],
        ['party', () => prismaService.party.deleteMany({ where: { companyId: COMPANY } })],
        ['productVariant', () => prismaService.productVariant.deleteMany({ where: { companyId: COMPANY } })],
        ['productTemplate', () => prismaService.productTemplate.deleteMany({ where: { companyId: COMPANY } })],
        ['productCategory', () => prismaService.productCategory.deleteMany({ where: { companyId: COMPANY } })],
        ['postingRule', () => prismaService.postingRule.deleteMany({ where: { companyId: COMPANY } })],
        ['chartOfAccount', () => prismaService.chartOfAccount.deleteMany({ where: { companyId: COMPANY } })],
        ['sequence', () => prismaService.sequence.deleteMany({ where: { companyId: COMPANY } })],
      ];
      for (const [name, run] of steps) {
        try {
          await run();
        } catch (e) {
          failures.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      try {
        await prismaService.company.delete({ where: { id: COMPANY } });
      } catch (e) {
        failures.push(`company: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      await prismaService.$disconnect();
    }
    if (failures.length > 0) {
      throw new Error(`g7d cleanup INCOMPLETE — test data left behind: ${failures.join(' | ')}`);
    }
  });

  itif('g7d-01 journal-entry drill-down returns lines and reversal linkage', async () => {
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'BANK', debit: 500, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 500 },
      ],
    });
    myEntryIds.push(entry.id);
    const { reversal } = await journal.reverse(entry.id, ACTOR);
    myEntryIds.push(reversal.id);

    const original = await reports.journalEntry(COMPANY, entry.id);
    expect(original.status).toBe('REVERSED');
    expect(original.reversedBy?.id).toBe(reversal.id);
    expect(original.lines).toHaveLength(2);
    expect(original.lines.map((l) => l.accountCode).sort()).toEqual(['BANK', 'SALES_REVENUE']);
    const bank = original.lines.find((l) => l.accountCode === 'BANK')!;
    expect(bank.debit.toString()).toBe('500');

    const mirror = await reports.journalEntry(COMPANY, reversal.id);
    expect(mirror.status).toBe('POSTED');
    expect(mirror.reversalOf?.id).toBe(entry.id);
    const bankMirror = mirror.lines.find((l) => l.accountCode === 'BANK')!;
    expect(bankMirror.credit.toString()).toBe('500');
  });

  itif('g7d-02 journal-entry drill-down is company-isolated', async () => {
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'BANK', debit: 10, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 10 },
      ],
    });
    myEntryIds.push(entry.id);
    // a foreign (valid-format) company id must NOT see the entry
    await expect(
      reports.journalEntry('00000000-0000-4000-8000-00000000000f', entry.id),
    ).rejects.toThrow('JOURNAL_ENTRY_NOT_FOUND');
  });

  itif('g7d-07 subsidiary ledger: customer drills RECEIVABLE, supplier drills PAYABLE', async () => {
    const customer = await prismaService.party.create({
      data: { companyId: COMPANY, type: 'PERSON', nameFa: 'g7d مشتری', roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    const supplier = await prismaService.party.create({
      data: { companyId: COMPANY, type: 'PERSON', nameFa: 'g7d تامین‌کننده', roles: { create: [{ role: 'SUPPLIER' }] } },
    });
    // customer: RECEIVABLE debit 300; supplier: PAYABLE credit 500
    const custEntry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'RECEIVABLE', debit: 300, credit: 0, partyId: customer.id },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 300 },
      ],
    });
    myEntryIds.push(custEntry.id);
    // supplier entry: PAYABLE credit 500 (debit side on the revenue account)
    const supplierEntry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'SALES_REVENUE', debit: 500, credit: 0 },
        { accountCode: 'PAYABLE', debit: 0, credit: 500, partyId: supplier.id },
      ],
    });
    myEntryIds.push(supplierEntry.id);

    // the controller default is RECEIVABLE (unchanged contract): customer drill works
    const custLedger = await subsidiary.partyLedger(COMPANY, customer.id, { accountCode: 'RECEIVABLE' });
    expect(custLedger.rows.some((r) => r.debit.toString() === '300')).toBe(true);
    // that same default on a supplier returns NO rows — the caller must ask for PAYABLE
    const supplierDefault = await subsidiary.partyLedger(COMPANY, supplier.id, { accountCode: 'RECEIVABLE' });
    expect(supplierDefault.rows).toHaveLength(0);
    // explicit PAYABLE returns the supplier's ledger (what the UI now sends)
    const supplierPayable = await subsidiary.partyLedger(COMPANY, supplier.id, { accountCode: 'PAYABLE' });
    const row = supplierPayable.rows.find((r) => r.credit.toString() === '500');
    expect(row).toBeTruthy();
        // liability runs CREDIT-positive (normal side), so +500 — not negative
    expect(row!.runningBalance.toString()).toBe('500');
  });

  itif('g7d-08 retry posts a FAILED event against its stored payload', async () => {
    const srcEntry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'OPERATIONAL',
      documentType: 'PURCHASE_FULFILLED',
      lines: [
        { accountCode: 'INVENTORY', debit: 150, credit: 0 },
        { accountCode: 'PURCHASE_EXPENSE', debit: 0, credit: 150 },
      ],
    });
    myEntryIds.push(srcEntry.id);
    // the FINANCIAL date the retry must reproduce — not the retry timestamp
    const financialDate = new Date(Date.now() - 5 * 86400000);
    financialDate.setUTCHours(9, 30, 0, 0);
    // a FAILED event as the queue would leave it (payload measures are strings)
    await prismaService.accountingEvent.create({
      data: {
        companyId: COMPANY,
        eventType: 'PURCHASE_FULFILLED',
        sourceEntityType: 'purchase_document',
        sourceEntityId: srcEntry.id,
        payload: {
          measures: { INVENTORY: '150', PAYABLE: '150' },
          analytics: {},
          reversal: false,
          entryDate: financialDate.toISOString(),
        } as unknown as Prisma.InputJsonValue,
        status: 'FAILED',
        error: 'simulated failure',
        idempotencyKey: `g7d-08:${Date.now()}`,
      },
    });
    // posting rule: INVENTORY debit / PAYABLE credit, measure-driven
    await prismaService.postingRule.create({
      data: {
        companyId: COMPANY,
        code: 'G7D-PURCHASE',
        nameFa: 'قاعده خرید g7d',
        eventType: 'PURCHASE_FULFILLED',
        lines: {
          create: [
            { side: 'DEBIT', accountCode: 'INVENTORY', measure: 'INVENTORY', order: 1 },
            { side: 'CREDIT', accountCode: 'PAYABLE', measure: 'PAYABLE', order: 2 },
          ],
        },
      },
    });
    const listed = await events.list(COMPANY, { status: 'FAILED' });
    expect(listed.items).toHaveLength(1);
    const failedId = listed.items[0].id;

    const retry = await events.retry(COMPANY, failedId);
    expect(retry.status).toBe('POSTED');
    const fresh = await prismaService.accountingEvent.findUniqueOrThrow({ where: { id: failedId } });
    expect(fresh.status).toBe('POSTED');
    expect(fresh.journalEntryId).toBeTruthy();
    myEntryIds.push(fresh.journalEntryId!);
    // the reposted journal carries the PRESERVED financial date, not the retry time
    const reposted = await prismaService.journalEntry.findUniqueOrThrow({
      where: { id: fresh.journalEntryId! },
      select: { entryDate: true },
    });
    expect(reposted.entryDate.toISOString()).toBe(financialDate.toISOString());
    // idempotent: retrying a POSTED event does nothing harmful
    const again = await events.retry(COMPANY, failedId);
    expect(again.status).toBe('POSTED');
  });

  itif('g7d-09 profit report carries variant display name', async () => {
    const variant = await prismaService.productVariant.create({
      data: {
        companyId: COMPANY,
        templateId: (
          await prismaService.productTemplate.create({
            data: {
              companyId: COMPANY,
              categoryId: (await prismaService.productCategory.create({ data: { companyId: COMPANY, code: 'G7D', nameFa: 'گروه g7d' } })).id,
              nameFa: 'g7d قالب',
            },
          })
        ).id,
        sku: 'G7D-V1',
        nameFa: 'میلگرد g7d',
        combinationKey: 'g7d-v1',
      },
    });
    const srcEntry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'OPERATIONAL',
      documentType: 'SALES_COMPLETED_LOADING',
      lines: [
        { accountCode: 'RECEIVABLE', debit: 80, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 80 },
      ],
    });
    myEntryIds.push(srcEntry.id);
    await prismaService.accountingEvent.create({
      data: {
        companyId: COMPANY,
        eventType: 'SALES_COMPLETED_LOADING',
        sourceEntityType: 'sales_document',
        sourceEntityId: srcEntry.id,
        journalEntryId: srcEntry.id,
        payload: {
          measures: { REVENUE: '80', COGS: '30' },
          analytics: { productVariantId: variant.id },
          reversal: false,
        } as unknown as Prisma.InputJsonValue,
        status: 'POSTED',
        idempotencyKey: `g7d-09:${Date.now()}`,
      },
    });
    const report = await profit.operationalProfit(COMPANY, {});
    const row = report.rows.find((r) => r.productVariantId === variant.id);
    expect(row).toBeTruthy();
    expect(row!.variantNameFa).toBe('میلگرد g7d');
    // Decimal-exact totals
    expect(row!.revenue.toString()).toBe('80');
    expect(row!.grossProfit.toString()).toBe('50');
  });

  itif('g7d-03 close year rejects posting; reopen year keeps periods closed; explicit period reopen restores posting', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const year = (await fiscal.create(COMPANY, {
      code: `G7D${Date.now()}`.slice(-9),
      nameFa: 'سال تست g7d',
      startDate: today,
      endDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10),
    }, ACTOR)) as never as { id: string; status: string };
    myFiscalYearIds.push(year.id);

    const post = () =>
      journal.post(prismaService as never, {
        companyId: COMPANY,
        entryDate: new Date(),
        lines: [
          { accountCode: 'BANK', debit: 25, credit: 0 },
          { accountCode: 'SALES_REVENUE', debit: 0, credit: 25 },
        ],
      });

    // posting works inside an open year
    const before = await post();
    myEntryIds.push(before.id);
    await prismaService.journalEntry.delete({ where: { id: before.id } });

    // close year → posting rejected (FISCAL_YEAR_CLOSED)
    await fiscal.closeYear(COMPANY, year.id, ACTOR);
    await expect(post()).rejects.toThrow('FISCAL_YEAR_CLOSED');

    // reopen year → year OPEN again, but its periods remain CLOSED (narrow reopen)
    const reopened = await fiscal.reopenYear(COMPANY, year.id, ACTOR);
    expect(reopened.status).toBe('OPEN');

    // the applicable period MUST exist (generateMonthlyPeriods covers today)
    const period = await prismaService.fiscalPeriod.findFirst({
      where: { fiscalYearId: year.id, startDate: { lte: new Date(today) }, endDate: { gte: new Date(today) } },
    });
    expect(period).toBeTruthy();
    // and it must still be CLOSED — posting is rejected for THAT reason
    expect((await prismaService.fiscalPeriod.findUniqueOrThrow({ where: { id: period!.id } })).status).toBe('CLOSED');
    await expect(post()).rejects.toThrow('PERIOD_CLOSED');

    // explicitly reopen the period → posting succeeds again (proven, not assumed)
    await fiscal.setPeriodStatus(COMPANY, year.id, period!.id, 'OPEN', ACTOR);
    const after = await post();
    myEntryIds.push(after.id); // registered before any assertion (cleanup safety)
    expect(after.status).toBe('POSTED');
    await prismaService.journalEntry.delete({ where: { id: after.id } });

    // reopen on an already-open year is rejected (no accidental transitions)
    await expect(fiscal.reopenYear(COMPANY, year.id, ACTOR)).rejects.toThrow('FISCAL_YEAR_ALREADY_OPEN');
  });

  itif('g7d-04 close/reopen year are audited', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const year = (await fiscal.create(COMPANY, {
      code: `G7DA${Date.now()}`.slice(-9),
      nameFa: 'سال تست audit g7d',
      startDate: today,
      endDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10),
    }, ACTOR)) as never as { id: string };
    myFiscalYearIds.push(year.id);
    await fiscal.closeYear(COMPANY, year.id, ACTOR);
    await fiscal.reopenYear(COMPANY, year.id, ACTOR);
    const audits = await prismaService.auditLog.findMany({
      where: { entityType: 'fiscal_year', entityId: year.id, companyId: COMPANY },
      orderBy: { createdAt: 'asc' },
    });
    const actions = audits.map((a) => a.action);
    expect(actions).toContain('CLOSE');
    expect(actions).toContain('REOPEN');
  });

  itif('g7d-05 seeded roles: accountant holds accounting perms, operational roles do not', async () => {
    const shared = integrationPrisma();
    const loadRole = async (code: string) => {
      const role = await shared.role.findFirst({
        where: { code },
        include: { permissions: { include: { permission: true } } },
      });
      expect(role).toBeTruthy();
      return role!.permissions.map((p) => p.permission.code);
    };
    // the accountant is the ONLY non-admin role with accounting powers
    const accountantCodes = await loadRole('accountant');
    expect(accountantCodes).toContain('accounting.report');
    expect(accountantCodes).toContain('accounting.fiscal.manage');
    expect(accountantCodes).toContain('accounting.posting.manage');
    // operational roles must NOT see financial reports or manage fiscal data
    for (const roleCode of ['salesperson', 'buyer', 'purchase_manager', 'financial_manager']) {
      const codes = await loadRole(roleCode);
      expect(codes).not.toContain('accounting.report');
      expect(codes).not.toContain('accounting.fiscal.manage');
      expect(codes).not.toContain('accounting.posting.manage');
    }
  });

  itif('g7d-10 concurrent retries of one event post exactly one journal', async () => {
    const srcEntry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'OPERATIONAL',
      documentType: 'PURCHASE_FULFILLED',
      lines: [
        { accountCode: 'INVENTORY', debit: 60, credit: 0 },
        { accountCode: 'PURCHASE_EXPENSE', debit: 0, credit: 60 },
      ],
    });
    myEntryIds.push(srcEntry.id);
    const ev = await prismaService.accountingEvent.create({
      data: {
        companyId: COMPANY,
        eventType: 'PURCHASE_FULFILLED',
        sourceEntityType: 'purchase_document',
        sourceEntityId: srcEntry.id,
        payload: {
          measures: { INVENTORY: '60', PAYABLE: '60' },
          analytics: {},
          reversal: false,
        } as unknown as Prisma.InputJsonValue,
        status: 'FAILED',
        error: 'simulated',
        idempotencyKey: `g7d-10:${Date.now()}`,
      },
    });
    await prismaService.postingRule.create({
      data: {
        companyId: COMPANY,
        code: 'G7D-CONCURRENT',
        nameFa: 'قاعده هم‌زمانی g7d',
        eventType: 'PURCHASE_FULFILLED',
        lines: {
          create: [
            { side: 'DEBIT', accountCode: 'INVENTORY', measure: 'INVENTORY', order: 1 },
            { side: 'CREDIT', accountCode: 'PAYABLE', measure: 'PAYABLE', order: 2 },
          ],
        },
      },
    });
    // two simultaneous retries — the advisory lock serializes them
    const [a, b] = await Promise.all([
      events.retry(COMPANY, ev.id),
      events.retry(COMPANY, ev.id),
    ]);
    expect(a.status).toBe('POSTED');
    expect(b.status).toBe('POSTED');
    const journalsForEvent = await prismaService.journalEntry.findMany({
      where: { companyId: COMPANY, documentType: 'PURCHASE_FULFILLED' },
      include: { lines: true },
    });
    // exactly ONE NEW journal from the retries — srcEntry itself is also a
    // PURCHASE_FULFILLED journal with debit 60, so exclude it explicitly
    const g7d10Journals = journalsForEvent.filter(
      (j) => j.id !== srcEntry.id && j.lines.some((l) => l.debit.toString() === '60'),
    );
    expect(g7d10Journals).toHaveLength(1);
    const fresh = await prismaService.accountingEvent.findUniqueOrThrow({ where: { id: ev.id } });
    expect(fresh.status).toBe('POSTED');
    myEntryIds.push(fresh.journalEntryId!);
  });

  itif('g7d-11 fiscal year: duplicate code and invalid range rejected; monthly periods contiguous', async () => {
    const yearCode = `G7DX${Date.now()}`.slice(-8);
    const start = '2026-03-01';
    const end = '2026-05-31';
    const year = (await fiscal.create(COMPANY, {
      code: yearCode,
      nameFa: 'سال ممیزی g7d',
      startDate: start,
      endDate: end,
    }, ACTOR)) as never as { id: string; status: string };
    myFiscalYearIds.push(year.id);
    // duplicate code rejected
    await expect(
      fiscal.create(COMPANY, { code: yearCode, nameFa: 'تکراری', startDate: start, endDate: end }, ACTOR),
    ).rejects.toThrow('FISCAL_YEAR_EXISTS');
    // invalid range rejected
    await expect(
      fiscal.create(COMPANY, {
        code: `${yearCode}B`,
        nameFa: 'بازه معکوس',
        startDate: end,
        endDate: start,
      }, ACTOR),
    ).rejects.toThrow('INVALID_FISCAL_RANGE');
    // monthly periods: contiguous (no gap/overlap) and inside the year
    const periods = await prismaService.fiscalPeriod.findMany({
      where: { fiscalYearId: year.id },
      orderBy: { code: 'asc' },
    });
    expect(periods.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < periods.length; i += 1) {
      const prevEnd = periods[i - 1].endDate;
      const curStart = periods[i].startDate;
      const gapDays = (curStart.getTime() - prevEnd.getTime()) / 86400000;
      expect(gapDays).toBeCloseTo(1, 5); // next starts the day after previous ends
    }
    expect(periods[0].startDate.toISOString().slice(0, 10)).toBe(start);
    const last = periods[periods.length - 1];
    expect(last.endDate.toISOString().slice(0, 10)).toBe(end);
  });

  itif('g7d-12 journal-committed-but-event-FAILED is recovered without a duplicate', async () => {
    // The reviewed failure mode, materialized as durable DB state: the journal
    // WAS created (source_event_id set) but the event status persistence left
    // it FAILED without journalEntryId. This state is exactly what a crash
    // between the two old writes produced — and what the unique key now makes
    // recoverable instead of duplicate-prone.
    const ev = await prismaService.accountingEvent.create({
      data: {
        companyId: COMPANY,
        eventType: 'PURCHASE_FULFILLED',
        sourceEntityType: 'purchase_document',
        sourceEntityId: '00000000-0000-4000-8000-0000000000d1',
        payload: {
          measures: { INVENTORY: '150', PAYABLE: '150' },
          analytics: {},
          reversal: false,
        } as unknown as Prisma.InputJsonValue,
        status: 'FAILED',
        error: 'event status persistence failed historically',
        idempotencyKey: `g7d-12:${Date.now()}`,
      },
    });
    const preExisting = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'OPERATIONAL',
      documentType: 'PURCHASE_FULFILLED',
      sourceEventId: ev.id, // the durable link a crashed write left behind
      lines: [
        { accountCode: 'INVENTORY', debit: 150, credit: 0 },
        { accountCode: 'PURCHASE_EXPENSE', debit: 0, credit: 150 },
      ],
    });
    myEntryIds.push(preExisting.id);
    // posting rule (shared with g7d-08)
    await prismaService.postingRule.create({
      data: {
        companyId: COMPANY,
        code: 'G7D-RECOVER',
        nameFa: 'قاعده بازیابی g7d',
        eventType: 'PURCHASE_FULFILLED',
        lines: {
          create: [
            { side: 'DEBIT', accountCode: 'INVENTORY', measure: 'INVENTORY', order: 1 },
            { side: 'CREDIT', accountCode: 'PAYABLE', measure: 'PAYABLE', order: 2 },
          ],
        },
      },
    });
    // retry (fresh instance == restart semantics) — must RECONCILE, not repost
    const freshInstance = new AccountingEventService(prismaService as never, journal);
    const res = await freshInstance.retry(COMPANY, ev.id);
    expect(res.status).toBe('POSTED');
    // linked to the PRE-EXISTING journal; exactly ONE journal for this event
    const linked = await prismaService.journalEntry.findMany({
      where: { companyId: COMPANY, sourceEventId: ev.id },
      include: { lines: true },
    });
    expect(linked).toHaveLength(1);
    expect(linked[0].id).toBe(preExisting.id);
    // totals consistent
    expect(linked[0].lines.find((l) => l.debit.toString() === '150')).toBeTruthy();
    expect(linked[0].lines.find((l) => l.credit.toString() === '150')).toBeTruthy();
    // repeated retries after recovery: idempotent, still one journal
    for (let i = 0; i < 2; i += 1) {
      const again = await freshInstance.retry(COMPANY, ev.id);
      expect(again.status).toBe('POSTED');
    }
    expect(
      (await prismaService.journalEntry.findMany({ where: { companyId: COMPANY, sourceEventId: ev.id } })),
    ).toHaveLength(1);
  });

  itif('g7d-13 two independent service instances cannot duplicate one event', async () => {
    const ev = await prismaService.accountingEvent.create({
      data: {
        companyId: COMPANY,
        eventType: 'PURCHASE_FULFILLED',
        sourceEntityType: 'purchase_document',
        sourceEntityId: '00000000-0000-4000-8000-0000000000d2',
        payload: {
          measures: { INVENTORY: '75', PAYABLE: '75' },
          analytics: {},
          reversal: false,
        } as unknown as Prisma.InputJsonValue,
        status: 'FAILED',
        error: 'simulated',
        idempotencyKey: `g7d-13:${Date.now()}`,
      },
    });
    await prismaService.postingRule.create({
      data: {
        companyId: COMPANY,
        code: 'G7D-XINSTANCE',
        nameFa: 'قاعده چندنمونه‌ای g7d',
        eventType: 'PURCHASE_FULFILLED',
        lines: {
          create: [
            { side: 'DEBIT', accountCode: 'INVENTORY', measure: 'INVENTORY', order: 1 },
            { side: 'CREDIT', accountCode: 'PAYABLE', measure: 'PAYABLE', order: 2 },
          ],
        },
      },
    });
    // instance B: its own PrismaClient (no shared in-process gate)
    const clientB = new PrismaClient();
    try {
      const serviceB = new AccountingEventService(clientB as never, journal);
      const [a, b] = await Promise.all([
        events.retry(COMPANY, ev.id),
        serviceB.retry(COMPANY, ev.id),
      ]);
      expect(a.status).toBe('POSTED');
      expect(b.status).toBe('POSTED');
      // the DB-unique source_event_id allowed exactly ONE journal
      const linked = await prismaService.journalEntry.findMany({
        where: { companyId: COMPANY, sourceEventId: ev.id },
        include: { lines: true },
      });
      expect(linked).toHaveLength(1);
      expect(linked[0].lines.find((l) => l.debit.toString() === '75')).toBeTruthy();
      const fresh = await prismaService.accountingEvent.findUniqueOrThrow({ where: { id: ev.id } });
      expect(fresh.status).toBe('POSTED');
      expect(fresh.journalEntryId).toBe(linked[0].id);
      myEntryIds.push(fresh.journalEntryId!);
    } finally {
      await clientB.$disconnect();
    }
  });

  itif('g7d-14 two legitimate distinct events create two separate journals', async () => {
    const mkEvent = async (amount: string, key: string) => {
      const src = await journal.post(prismaService as never, {
        companyId: COMPANY,
        entryDate: new Date(),
        journalCode: 'OPERATIONAL',
        documentType: 'PURCHASE_FULFILLED',
        lines: [
          { accountCode: 'INVENTORY', debit: Number(amount), credit: 0 },
          { accountCode: 'PURCHASE_EXPENSE', debit: 0, credit: Number(amount) },
        ],
      });
      myEntryIds.push(src.id);
      return prismaService.accountingEvent.create({
        data: {
          companyId: COMPANY,
          eventType: 'PURCHASE_FULFILLED',
          sourceEntityType: 'purchase_document',
          sourceEntityId: src.id,
          payload: {
            measures: { INVENTORY: amount, PAYABLE: amount },
            analytics: {},
            reversal: false,
          } as unknown as Prisma.InputJsonValue,
          status: 'FAILED',
          error: 'simulated',
          idempotencyKey: key,
        },
      });
    };
    const e1 = await mkEvent('100', `g7d-14a:${Date.now()}`);
    const e2 = await mkEvent('200', `g7d-14b:${Date.now()}`);
    await events.retry(COMPANY, e1.id);
    await events.retry(COMPANY, e2.id);
    const j1 = await prismaService.journalEntry.findFirstOrThrow({
      where: { companyId: COMPANY, sourceEventId: e1.id },
    });
    const j2 = await prismaService.journalEntry.findFirstOrThrow({
      where: { companyId: COMPANY, sourceEventId: e2.id },
    });
    expect(j1.id).not.toBe(j2.id);
    myEntryIds.push(j1.id, j2.id);
    // each journal carries exactly its own event's amounts
    const totals = await Promise.all(
      [j1, j2].map((j) =>
        prismaService.journalLine.findMany({ where: { journalEntryId: j.id } }),
      ),
    );
    const debitOf = (lines: { debit: Prisma.Decimal }[]) =>
      lines.reduce((s, l) => s.plus(l.debit), new Prisma.Decimal(0));
    expect(debitOf(totals[0]).toString()).toBe('100');
    expect(debitOf(totals[1]).toString()).toBe('200');
  });

  itif('g7d-06 cleanup regression: an entry orphaned by a mid-test assertion failure leaves no data behind', async () => {
    // Simulate the failure path: post + register the id, then swallow a
    // FAILED assertion (exactly what a broken mid-test expect would do) and
    // deliberately skip the inline delete. The suite's afterAll must remove
    // the orphan: entries are deleted company-scoped and the hermetic company
    // is deleted last — any leftover row would FK-block that delete and the
    // afterAll throws `g7d cleanup INCOMPLETE`, failing the whole suite.
    const orphan = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'BANK', debit: 7, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 7 },
      ],
    });
    myEntryIds.push(orphan.id); // registered before the simulated failure
    try {
      expect(orphan.status).toBe('NOT_A_REAL_STATUS'); // deliberately fails
    } catch {
      // swallowed: the test continues past its "broken" assertion — cleanup
      // must not depend on anything below this line having run
    }
    // no inline delete on purpose — afterAll owns this row now
  });
});
