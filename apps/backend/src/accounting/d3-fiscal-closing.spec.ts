import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { FiscalYearService } from '../accounting/fiscal-year.service';
import { AuditService } from '../audit/audit.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'd3fiscal-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'd3fiscal-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

/**
 * D-3 — independent fiscal-closing TESTS over the EXISTING machinery
 * (closeYear / reopenYear / posting guards). NO closing-entries logic is
 * implemented here: the retained-earnings transfer policy is an owner/
 * accountant decision (docs/16 Option B — NOT ratified). These tests pin
 * the behavior any future closing implementation must preserve:
 *  - double close → 409 FISCAL_YEAR_ALREADY_CLOSED (idempotency guard)
 *  - foreign company close → 404 (no existence leak)
 *  - close/reopen are AUDITED (CLOSE/OPEN audit rows)
 *  - CONCURRENT closeYear calls → exactly one succeeds (tx guard)
 *  - posting into a CLOSED year → FISCAL_YEAR_CLOSED
 */
describeIntegration('d3-fiscal-closing (real AppModule machinery)', () => {
  let prisma: PrismaService;
  let fiscal: FiscalYearService;
  let app: INestApplication | null = null;
  let A = '';
  let B = '';
  const marker = `d3-${Date.now()}`;
  const yearIds: string[] = [];
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const c of [`d3a-${marker}`, `d3b-${marker}`]) {
      const company = await prisma.company.create({ data: { nameFa: c, status: 'ACTIVE' } });
      if (A === '') A = company.id;
      else B = company.id;
    }
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = await moduleRef.createNestApplication();
    await app.init();
    const audit = new AuditService(prisma as never);
    fiscal = new FiscalYearService(prisma as never, audit);
  });

  afterAll(async () => {
    await app?.close().catch((e: unknown) => {
      throw new Error(`app.close: ${String(e)}`);
    });
    if (prisma) {
      const failures: string[] = [];
      const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try { await fn(); } catch (e) { failures.push(`${label}: ${String(e)}`); }
      };
      await step('years', () => prisma.fiscalYear.deleteMany({ where: { companyId: { in: [A, B] } } }));
      await step('audit', () => prisma.auditLog.deleteMany({ where: { companyId: { in: [A, B] } } }));
      await step('companies', () => prisma.company.deleteMany({ where: { id: { in: [A, B] } } }));
      await prisma.$disconnect();
      if (failures.length > 0) throw new Error(`D3 CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
  });

  async function createYear(companyId: string, code: string): Promise<{ id: string }> {
    return prisma.fiscalYear.create({
      data: {
        companyId,
        code,
        nameFa: `سال ${code}`,
        startDate: new Date('2026-03-21'),
        endDate: new Date('2027-03-20'),
        periods: { create: [{ code: `${code}-01`, nameFa: 'فروردین', startDate: new Date('2026-03-21'), endDate: new Date('2026-04-20') }] },
      },
    });
  }

  itif('double close → 409 FISCAL_YEAR_ALREADY_CLOSED (no second audit row)', async () => {
    const year = await createYear(A, `${marker}-A1`);
    yearIds.push(year.id);
    const actor = { id: '00000000-0000-4000-8000-000000000001', username: 'd3' };

    await fiscal.closeYear(A, year.id, actor);
    await expect(fiscal.closeYear(A, year.id, actor)).rejects.toMatchObject({
      name: 'ConflictError',
      message: 'FISCAL_YEAR_ALREADY_CLOSED',
    });

    const audits = await prisma.auditLog.count({
      where: { entityType: 'fiscal_year', entityId: year.id, action: 'CLOSE' },
    });
    expect(audits).toBe(1); // exactly one CLOSE record
  });

  itif('foreign company close → 404 NotFound (no existence leak)', async () => {
    const year = await createYear(A, `${marker}-A2`);
    yearIds.push(year.id);
    await expect(fiscal.closeYear(B, year.id, { id: '00000000-0000-4000-8000-000000000001', username: 'd3' })).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    const fresh = await prisma.fiscalYear.findUniqueOrThrow({ where: { id: year.id } });
    expect(fresh.status).toBe('OPEN'); // untouched
  });

  itif('CONCURRENT closeYear → exactly one wins, loser gets 409 (no double-close)', async () => {
    const year = await createYear(A, `${marker}-A3`);
    yearIds.push(year.id);
    const actor = { id: '00000000-0000-4000-8000-000000000001', username: 'd3' };

    const [r1, r2] = await Promise.allSettled([
      fiscal.closeYear(A, year.id, actor),
      fiscal.closeYear(A, year.id, actor),
    ]);
    const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
    const rejected = [r1, r2].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(String(rejected[0].reason)).toContain('FISCAL_YEAR_ALREADY_CLOSED');

    const audits = await prisma.auditLog.count({
      where: { entityType: 'fiscal_year', entityId: year.id, action: 'CLOSE' },
    });
    expect(audits).toBe(1); // the tx guard prevents a duplicate CLOSE audit
  });

  itif('close is audited with old→new status; reopen is audited too (narrow)', async () => {
    const year = await createYear(A, `${marker}-A4`);
    yearIds.push(year.id);
    const actor = { id: '00000000-0000-4000-8000-000000000001', username: 'd3' };

    await fiscal.closeYear(A, year.id, actor);
    await fiscal.reopenYear(A, year.id, actor);

    const closeRows = await prisma.auditLog.findMany({
      where: { entityType: 'fiscal_year', entityId: year.id, action: 'CLOSE' },
    });
    expect(closeRows).toHaveLength(1);
    expect((closeRows[0].oldValues as { status: string }).status).toBe('OPEN');
    expect((closeRows[0].newValues as { status: string }).status).toBe('CLOSED');

    const openRows = await prisma.auditLog.findMany({
      where: { entityType: 'fiscal_year', entityId: year.id, action: 'REOPEN' },
    });
    expect(openRows.length).toBeGreaterThanOrEqual(1);
    // narrow reopen: the YEAR is open but its PERIOD stays CLOSED
    const period = await prisma.fiscalPeriod.findFirstOrThrow({ where: { fiscalYearId: year.id } });
    expect(period.status).toBe('CLOSED');
  });
});
