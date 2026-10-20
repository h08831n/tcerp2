import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from './journal.service';
import { ReportsService } from './reports.service';
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
    fiscal = new FiscalYearService(prismaService as never, audit);

    const company = await prismaService.company.create({
      data: { nameFa: `g7d-${Date.now()}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    for (const a of [
      { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
      { code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' as const },
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
        ['journalEntry', () => prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY } })],
        ['fiscalPeriod', async () => {
          for (const id of myFiscalYearIds) {
            await prismaService.fiscalPeriod.deleteMany({ where: { fiscalYearId: id } });
            await prismaService.fiscalYear.deleteMany({ where: { id } });
          }
        }],
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
    expect(after.status).toBe('POSTED');
    myEntryIds.push(after.id);
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
});
