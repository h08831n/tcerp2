import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { PrismaService } from './prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from './testing/integration';
import { assertSafeIntegrationDatabase } from './testing/db-guard';
import * as bcrypt from 'bcryptjs';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'backlog-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'backlog-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const PASSWORD = 'Backlog-Passw0rd!1';
const ADMIN_PASSWORD = 'Backlog-Admin-Passw0rd!';

/**
 * Backlog security closure — real HTTP over the REAL AppModule:
 *  1. access-token REVOCATION on password reset (tokenVersion): the access
 *     token issued BEFORE a reset must be dead on the NEXT request, even
 *     though its JWT signature and TTL are still valid.
 *  2. refresh-token rotation stays intact (existing gate-c-auth coverage;
 *     here we assert the old REFRESH token dies together with the access
 *     token when an admin reset happens between requests).
 */
describeIntegration('backlog-security (real AppModule + guards)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let companyId = '';
  const marker = `backlog-${Date.now()}`;
  const createdUserIds: string[] = [];
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    const company = await prisma.company.create({ data: { nameFa: `backlog-${marker}`, status: 'ACTIVE' } });
    companyId = company.id;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = await moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api');
    nestApp.use(require('cookie-parser')());
    nestApp.useGlobalFilters(new GlobalExceptionFilter());
    await nestApp.init();
    const server = nestApp.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = nestApp;
  });

  afterAll(async () => {
    await app?.close().catch((e: unknown) => {
      throw new Error(`app.close: ${String(e)}`);
    });
    if (prisma) {
      for (const id of createdUserIds) {
        await prisma.refreshToken.deleteMany({ where: { userId: id } });
        await prisma.auditLog.deleteMany({ where: { entityType: 'user', entityId: id } });
        await prisma.auditLog.deleteMany({ where: { entityType: 'auth', actorId: id } });
        await prisma.user.deleteMany({ where: { id } });
      }
      await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
      const left = await prisma.company.count({ where: { id: companyId } });
      if (left !== 0) throw new Error('LEFTOVER company');
      await prisma.$disconnect();
    }
  });

  async function createUser(username: string, password: string, status: 'ACTIVE' | 'DISABLED' = 'ACTIVE'): Promise<string> {
    const user = await prisma.user.create({
      data: { username, passwordHash: bcrypt.hashSync(password, 8), status },
    });
    createdUserIds.push(user.id);
    await prisma.userCompany.create({ data: { userId: user.id, companyId } });
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    await prisma.userCompanyRole.create({ data: { userId: user.id, companyId, roleId: adminRole.id } });
    return user.id;
  }

  function post(path: string, body: unknown, auth?: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-company-id': companyId,
        ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  async function login(username: string, password: string): Promise<string> {
    const res = await post('/api/auth/login', { identifier: username, password });
    expect(res.status).toBe(200);
    return ((await res.json()) as { accessToken?: string }).accessToken ?? '';
  }

  itif('backlog: ACCESS token issued BEFORE an admin password reset is dead on the next request', async () => {
    const username = `backlog-token-${marker}`;
    const userId = await createUser(username, PASSWORD);
    const adminId = await createUser(`backlog-admin-${marker}`, ADMIN_PASSWORD);
    const adminToken = await login(`backlog-admin-${marker}`, ADMIN_PASSWORD);

    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } });

    // The victim's access token WORKS right now.
    const accessToken = await login(username, PASSWORD);
    const meBefore = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(meBefore.status).toBe(200);

    // Admin resets the victim's password.
    const reset = await post(`/api/users/${userId}/password`, { password: 'Reset-New-Passw0rd!9' }, adminToken);
    expect([200, 201]).toContain(reset.status);

    // The SAME access token (valid JWT, not expired) must now be REJECTED.
    const meAfter = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(meAfter.status).toBe(401);

    // tokenVersion was incremented in the SAME update as the hash.
    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { tokenVersion: true } });
    expect(after.tokenVersion).toBe(before.tokenVersion + 1);

    // The new password works and issues a WORKING token (ver = new generation).
    const freshToken = await login(username, 'Reset-New-Passw0rd!9');
    const meFresh = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${freshToken}` } });
    expect(meFresh.status).toBe(200);
    void adminId;
  });

  itif('backlog: pre-reset access token survives an UNRELATED user update (no false revocation)', async () => {
    const username = `backlog-norevoke-${marker}`;
    await createUser(username, PASSWORD);
    const accessToken = await login(username, PASSWORD);

    // An unrelated update (touch timezone) must NOT rotate the generation.
    await prisma.user.update({ where: { username }, data: { language: 'fa' } });
    const me = await fetch(`${baseUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    expect(me.status).toBe(200);
  });
});

// journal.reverse companyId scope (backlog item) — service-level, real DB.
// journal.reverse companyId scope (backlog item) — service-level, real DB.
describeIntegration('backlog-security: journal.reverse company scope', () => {
  const ACTOR_ID = '00000000-0000-4000-8000-000000000001';
  let prisma: PrismaService;
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;
  let companyA = '';
  let companyB = '';
  let entryB = '';
  let accountCode = '';
  let fyB = '';

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    const a = await prisma.company.create({ data: { nameFa: `jrev-a-${Date.now()}`, status: 'ACTIVE' } });
    const b = await prisma.company.create({ data: { nameFa: `jrev-b-${Date.now()}`, status: 'ACTIVE' } });
    companyA = a.id;
    companyB = b.id;
    const stamp = Date.now();
    const account = await prisma.chartOfAccount.create({
      data: { companyId: companyB, code: `JREV-${stamp}`, name: 'جمع', type: 'ASSET' },
    });
    accountCode = account.code;
    const fy = await prisma.fiscalYear.create({
      data: {
        companyId: companyB, code: `${stamp}`, nameFa: `FY-${stamp}`,
        startDate: new Date('2026-03-21'), endDate: new Date('2027-03-20'),
        periods: { create: [{ code: `${stamp}-ALL`, nameFa: 'کل سال', startDate: new Date('2026-03-21'), endDate: new Date('2027-03-20') }] },
      },
    });
    fyB = fy.id;
    await prisma.chartOfAccount.create({
      data: { companyId: companyB, code: 'PURCHASE_EXPENSE', name: 'بهای تمام‌شده', type: 'EXPENSE' },
    });
    await prisma.sequence.create({
      data: { companyId: companyB, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JREV', padding: 5, resetCycle: 'NEVER' },
    });
    const contra = await prisma.chartOfAccount.create({
      data: { companyId: companyB, code: `JREVC-${stamp}`, name: 'کنترا', type: 'EXPENSE' },
    });
    const entry = await prisma.journalEntry.create({
      data: {
        companyId: companyB, entryNumber: `JREV-${stamp}`, entryDate: new Date('2026-04-01'),
        description: 'company B entry', status: 'POSTED',
        lines: {
          create: [
            { companyId: companyB, accountId: account.id, debit: 100, credit: 0, description: 'd' },
            { companyId: companyB, accountId: contra.id, debit: 0, credit: 100, description: 'c' },
          ],
        },
      },
    });
    entryB = entry.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    const failures: string[] = [];
    const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try { await fn(); } catch (e) { failures.push(`${label}: ${String(e)}`); }
    };
    await step('reversalLines', () => prisma.journalLine.deleteMany({ where: { entry: { companyId: companyB } } }));
    await step('entriesB', () => prisma.journalEntry.deleteMany({ where: { companyId: companyB } }));
    await step('accountsB', () => prisma.chartOfAccount.deleteMany({ where: { companyId: companyB } }));
    await step('fyB', () => prisma.fiscalYear.deleteMany({ where: { id: fyB } }));
    await step('overlapYears', () => prisma.fiscalYear.deleteMany({ where: { companyId: companyB, code: { startsWith: 'OVR' } } }));
    await step('sequencesB', () => prisma.sequence.deleteMany({ where: { companyId: companyB } }));
    await step('companies', () => prisma.company.deleteMany({ where: { id: { in: [companyA, companyB] } } }));
    await prisma.$disconnect();
    if (failures.length > 0) throw new Error(`CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
  });

  itif('journal.reverse with a FOREIGN companyId → NotFound (no reversal, no leak)', async () => {
    const { JournalService } = await import('./accounting/journal.service');
    const { SequencesService } = await import('./sequences/sequences.service');
    const { AuditService } = await import('./audit/audit.service');
    const service = new JournalService(prisma as never, new SequencesService(prisma as never, new AuditService(prisma)));
    await expect(service.reverse(entryB, { id: ACTOR_ID }, companyA)).rejects.toMatchObject({
      name: 'NotFoundError',
    });
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: entryB } });
    expect(entry.status).toBe('POSTED'); // untouched
  });


  itif('assertOpenPeriod: OVERLAPPING years — posting uses the OPEN year (deterministic, no PERIOD_CLOSED flake)', async () => {
    const { JournalService } = await import('./accounting/journal.service');
    const { SequencesService } = await import('./sequences/sequences.service');
    const { AuditService } = await import('./audit/audit.service');
    const service = new JournalService(prisma as never, new SequencesService(prisma as never, new AuditService(prisma)));

    const stamp = Date.now();
    const closedYear = await prisma.fiscalYear.create({
      data: {
        companyId: companyB, code: `OVRC-${stamp}`, nameFa: 'بسته',
        startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'),
        status: 'CLOSED',
        periods: { create: [{ code: `OVRC-${stamp}`, nameFa: 'کل', startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'), status: 'CLOSED' }] },
      },
    });
    const openYear = await prisma.fiscalYear.create({
      data: {
        companyId: companyB, code: `OVRO-${stamp}`, nameFa: 'باز',
        startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'),
        status: 'OPEN',
        periods: { create: [{ code: `OVRO-${stamp}`, nameFa: 'کل', startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'), status: 'OPEN' }] },
      },
    });

    const entry = await service.post(prisma as never, {
      companyId: companyB,
      entryDate: new Date(),
      lines: [
        { accountCode, debit: 5, credit: 0 },
        { accountCode: 'PURCHASE_EXPENSE', debit: 0, credit: 5 },
      ],
    } as never);
    expect(entry.status).toBe('POSTED'); // untouched
  });


  itif('assertOpenPeriod: OVERLAPPING years — posting uses the OPEN year (deterministic, no PERIOD_CLOSED flake)', async () => {
    const { JournalService } = await import('./accounting/journal.service');
    const { SequencesService } = await import('./sequences/sequences.service');
    const { AuditService } = await import('./audit/audit.service');
    const service = new JournalService(prisma as never, new SequencesService(prisma as never, new AuditService(prisma)));

    const stamp = Date.now();
    const closedYear = await prisma.fiscalYear.create({
      data: {
        companyId: companyB, code: `OVRC-${stamp}`, nameFa: 'بسته',
        startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'),
        status: 'CLOSED',
        periods: { create: [{ code: `OVRC-${stamp}`, nameFa: 'کل', startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'), status: 'CLOSED' }] },
      },
    });
    const openYear = await prisma.fiscalYear.create({
      data: {
        companyId: companyB, code: `OVRO-${stamp}`, nameFa: 'باز',
        startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'),
        status: 'OPEN',
        periods: { create: [{ code: `OVRO-${stamp}`, nameFa: 'کل', startDate: new Date('2026-11-01'), endDate: new Date('2027-10-31'), status: 'OPEN' }] },
      },
    });

    // Posting into the overlap must resolve to the OPEN year/period — the old
    // unordered findFirst picked either one run-to-run (PERIOD_CLOSED flake).
    const entry = await service.post(prisma as never, {
      companyId: companyB,
      entryDate: new Date(),
      lines: [
        { accountCode, debit: 5, credit: 0 },
        { accountCode: 'PURCHASE_EXPENSE', debit: 0, credit: 5 },
      ],
    } as never);
    expect(entry.status).toBe('POSTED');
    void closedYear; void openYear;
  });

  itif('journal.reverse with the OWN companyId → reversal proceeds', async () => {
    const { JournalService } = await import('./accounting/journal.service');
    const { SequencesService } = await import('./sequences/sequences.service');
    const { AuditService } = await import('./audit/audit.service');
    const service = new JournalService(prisma as never, new SequencesService(prisma as never, new AuditService(prisma)));
    const result = await service.reverse(entryB, { id: ACTOR_ID }, companyB);
    expect(result.reversal.status).toBe('POSTED');
    expect(result.original.status).toBe('REVERSED');
  });
});
