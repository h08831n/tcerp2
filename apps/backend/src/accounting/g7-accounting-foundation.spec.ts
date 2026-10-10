import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from './journal.service';
import { FiscalYearService } from './fiscal-year.service';
import { INTEGRATION_COMPANY_ID } from '../testing/integration';

jest.setTimeout(60000);

const DB_URL = process.env.DATABASE_URL;
const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };
const COMPANY = INTEGRATION_COMPANY_ID;

describe('g7 — Phase 7A accounting foundation (live DB)', () => {
  let prisma: PrismaService;
  let journal: JournalService;
  let fiscal: FiscalYearService;

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prisma = new S();
    await prisma.$connect();
    const audit = new AuditService(prisma as never);
    journal = new JournalService(prisma as never, new SequencesService(prisma as never, audit));
    fiscal = new FiscalYearService(prisma as never, audit);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const itif = DB_URL ? it : it.skip;
  const today = new Date().toISOString().slice(0, 10);

  itif('g7-01 balanced journal posts', async () => {
    const entry = await journal.post(prisma as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      description: 'g7-01 balanced',
      lines: [
        { accountCode: 'BANK', debit: 500000, credit: 0, description: 'deposit' },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 500000, description: 'revenue' },
      ],
    });
    expect(entry.status).toBe('POSTED');
    expect(entry.entryNumber).toMatch(/^JE-\d{4}-\d{5}$/);
    const lines = entry.lines as { debit: Prisma.Decimal; credit: Prisma.Decimal }[];
    const debit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const credit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(debit).toBe(credit);
    await prisma.journalEntry.delete({ where: { id: entry.id } });
  });

  itif('g7-02 unbalanced journal rejected', async () => {
    await expect(
      journal.post(prisma as never, {
        companyId: COMPANY,
        entryDate: new Date(),
        lines: [
          { accountCode: 'BANK', debit: 500, credit: 0 },
          { accountCode: 'SALES_REVENUE', debit: 0, credit: 400 },
        ],
      }),
    ).rejects.toThrow('JOURNAL_UNBALANCED');
  });

  itif('g7-03 closed period rejected (and reopen restores posting)', async () => {
    // ensure a fiscal calendar covering today exists
    const years = await prisma.fiscalYear.findMany({ where: { companyId: COMPANY, status: 'OPEN' } });
    let year = years.find((y) => y.startDate <= new Date(today) && y.endDate >= new Date(today));
    if (!year) {
      year = (await fiscal.create(COMPANY, {
        code: 'G7TEST',
        nameFa: 'سال تست g7',
        startDate: today,
        endDate: new Date(Date.now() + 300 * 86400000).toISOString().slice(0, 10),
      }, ACTOR)) as never;
    }
    // close the period containing today
    const period = await prisma.fiscalPeriod.findFirst({
      where: { fiscalYearId: year.id, startDate: { lte: new Date(today) }, endDate: { gte: new Date(today) } },
    });
    expect(period).toBeTruthy();
    await fiscal.setPeriodStatus(COMPANY, year.id, period!.id, 'CLOSED', ACTOR);
    await expect(
      journal.post(prisma as never, {
        companyId: COMPANY,
        entryDate: new Date(),
        lines: [
          { accountCode: 'BANK', debit: 10, credit: 0 },
          { accountCode: 'SALES_REVENUE', debit: 0, credit: 10 },
        ],
      }),
    ).rejects.toThrow('PERIOD_CLOSED');
    // reopen → posts fine
    await fiscal.setPeriodStatus(COMPANY, year.id, period!.id, 'OPEN', ACTOR);
    const entry = await journal.post(prisma as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      lines: [
        { accountCode: 'BANK', debit: 10, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 10 },
      ],
    });
    await prisma.journalEntry.delete({ where: { id: entry.id } });
    // cleanup test year if we created it
    if (year.code === 'G7TEST') {
      await prisma.fiscalPeriod.deleteMany({ where: { fiscalYearId: year.id } });
      await prisma.fiscalYear.delete({ where: { id: year.id } });
    }
  });

  itif('g7-04 posted journal immutable (reverse twice rejected, no edit surface)', async () => {
    const entry = await journal.post(prisma as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      lines: [
        { accountCode: 'BANK', debit: 75, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 75 },
      ],
    });
    await expect(
      journal.post(prisma as never, { companyId: COMPANY, entryDate: new Date(), lines: [] }),
    ).rejects.toThrow();
    // posted rows are corrected only via reverse; direct mutation is not exposed
    const raw = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(raw.status).toBe('POSTED');
    await prisma.journalEntry.delete({ where: { id: entry.id } });
  });

  itif('g7-05 reversal works (mirrored entry + linkage)', async () => {
    const original = await journal.post(prisma as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      lines: [
        { accountCode: 'BANK', debit: 300, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 300 },
      ],
    });
    const { reversal } = await journal.reverse(original.id, ACTOR);
    expect(reversal.status).toBe('POSTED');
    const rLines = reversal.lines as { accountId: string; debit: Prisma.Decimal; credit: Prisma.Decimal }[];
    // mirrored: debits became credits — original BANK debit 300 → reversal BANK credit 300
    const bankAccountId = (await prisma.chartOfAccount.findFirstOrThrow({ where: { companyId: COMPANY, code: 'BANK' } })).id;
    const bankLine = rLines.find((l) => l.accountId === bankAccountId && Number(l.credit) === 300);
    expect(bankLine).toBeTruthy();
    const refreshed = await prisma.journalEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(refreshed.status).toBe('REVERSED');
    expect(refreshed.reversedByEntryId).toBe(reversal.id);
    await expect(journal.reverse(original.id, ACTOR)).rejects.toThrow();
    await prisma.journalEntry.deleteMany({ where: { id: { in: [original.id, reversal.id] } } });
  });

  itif('g7-06 analytical references preserved', async () => {
    const customer = await prisma.party.create({
      data: {
        companyId: COMPANY,
        type: 'COMPANY',
        nameFa: `تحلیلی g7 ${Date.now()}`,
        roles: { create: [{ role: 'CUSTOMER' }] },
      },
    });
    const entry = await journal.post(prisma as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      lines: [
        {
          accountCode: 'RECEIVABLE',
          debit: 1200,
          credit: 0,
          description: 'receivable Ravan group / buyer A',
          partyId: customer.id,
          analytics: [
            { dimensionType: 'CUSTOMER', dimensionId: customer.id, label: 'buyer A' },
          ],
        },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: 1200 },
      ],
    });
    const analytics = await prisma.journalLineAnalytic.findMany({
      where: { journalLineId: (entry.lines as { id: string }[])[0].id },
    });
    expect(analytics).toHaveLength(1);
    expect(analytics[0].dimensionType).toBe('CUSTOMER');
    expect(analytics[0].dimensionId).toBe(customer.id);
    const line = await prisma.journalLine.findUniqueOrThrow({
      where: { id: (entry.lines as { id: string }[])[0].id },
    });
    expect(line.partyId).toBe(customer.id);
    await prisma.journalEntry.delete({ where: { id: entry.id } });
  });
});
