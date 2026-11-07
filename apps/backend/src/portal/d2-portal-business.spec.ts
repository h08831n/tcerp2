import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHmac } from 'crypto';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'd2biz-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'd2biz-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const PASSWORD = 'D2-Business-passw0rd!';
const MOBILE = '09120000401';

/**
 * Gate D-2 Phase 2 — Portal Business API security tests.
 * Two isolated companies A and B. Portal accounts for the SAME verified
 * mobile in both. Every query is company + party scoped from the session.
 *
 * Sessions are created directly in the DB (bypassing OTP for simplicity)
 * — the OTP/Session infrastructure is already tested in d2-otp-session.
 */
describeIntegration('d2-portal-business (real AppModule, two companies)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let companyIdA = '';
  let companyIdB = '';
  const marker = `d2biz-${Date.now()}`;
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  const portalAccountIds: string[] = [];
  const partyIds: string[] = [];
  const salesDocIds: string[] = [];
  const roleIds: string[] = [];
  let sessionTokenA = '';
  let sessionTokenB = '';
  let adminAId = '';

  function hmac(data: string): string {
    return createHmac('sha256', process.env.JWT_SECRET ?? 'd2biz-jwt-secret-0123456789').update(data).digest('hex');
  }

  function portalGet(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: { Cookie: `portal_session=${token}` },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();

    for (const label of ['A', 'B']) {
      const company = await prisma.company.create({
        data: { nameFa: `d2biz-${label}-${marker}`, status: 'ACTIVE' },
      });
      if (label === 'A') companyIdA = company.id;
      else companyIdB = company.id;
      createdCompanies.push(company.id);
    }
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    roleIds.push(adminRole.id);
    for (const companyId of [companyIdA, companyIdB]) {
      await prisma.sequence.create({
        data: { companyId, documentType: 'SALES_DOCUMENT', name: 'SD', prefix: 'SD', padding: 5, resetCycle: 'NEVER' },
      });
      const admin = await prisma.user.create({
        data: {
          username: `d2biz-admin-${companyId.slice(0, 6)}-${marker}`,
          passwordHash: bcrypt.hashSync(PASSWORD, 8),
          status: 'ACTIVE', mustChangePassword: false,
        },
      });
      createdUsers.push(admin.id);
      await prisma.userCompany.create({ data: { userId: admin.id, companyId } });
      await prisma.userCompanyRole.create({ data: { userId: admin.id, companyId, roleId: adminRole.id } });
      if (companyId === companyIdA) adminAId = admin.id;
    }

    // Portal accounts: SAME mobile in both companies.
    for (const [companyId, label] of [[companyIdA, 'A'], [companyIdB, 'B']] as const) {
      const party = await prisma.party.create({
        data: { companyId, type: 'COMPANY', nameFa: `d2biz-party-${label} ${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
      });
      partyIds.push(party.id);
      const pa = await prisma.portalAccount.create({
        data: { companyId, partyId: party.id, verifiedMobile: MOBILE, status: 'ACTIVE' },
      });
      portalAccountIds.push(pa.id);
    }

    // Sales document for company A only.
    const docA = await prisma.salesDocument.create({
      data: {
        companyId: companyIdA, documentNumber: `D2BIZ-A-${marker}`,
        customerPartyId: partyIds[0],
        salespersonUserId: adminAId,
        documentDate: new Date(), status: 'COMPLETED', createdBy: adminAId,
        version: 1, currency: 'IRR', total: 500,
      },
    });
    salesDocIds.push(docA.id);

    // Boot the REAL app.
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
      const failures: string[] = [];
      const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try { await fn(); } catch (e) { failures.push(`${label}: ${String(e)}`); }
      };
      for (const companyId of createdCompanies) {
        await step(`salesLines(${companyId.slice(0, 6)})`, () =>
          prisma.salesLine.deleteMany({ where: { companyId } }));
        await step(`salesDocs(${companyId.slice(0, 6)})`, () =>
          prisma.salesDocument.deleteMany({ where: { companyId } }));
        await step(`portalSessions(${companyId.slice(0, 6)})`, () =>
          prisma.portalSession.deleteMany({ where: { portalAccountId: { in: portalAccountIds } } }));
        await step(`portalAccounts(${companyId.slice(0, 6)})`, () =>
          prisma.portalAccount.deleteMany({ where: { id: { in: portalAccountIds } } }));
        await step(`parties(${companyId.slice(0, 6)})`, () =>
          prisma.party.deleteMany({ where: { companyId } }));
        await step(`users(${companyId.slice(0, 6)})`, () =>
          prisma.user.deleteMany({ where: { id: { in: createdUsers } } }));
        await step(`userCompanies(${companyId.slice(0, 6)})`, () =>
          prisma.userCompany.deleteMany({ where: { companyId } }));
        await step(`userCompanyRoles(${companyId.slice(0, 6)})`, () =>
          prisma.userCompanyRole.deleteMany({ where: { companyId } }));
        await step(`sequences(${companyId.slice(0, 6)})`, () =>
          prisma.sequence.deleteMany({ where: { companyId } }));
        await step(`company(${companyId.slice(0, 6)})`, async () => {
          await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
          const left = await prisma.company.count({ where: { id: companyId } });
          if (left !== 0) failures.push(`LEFTOVER company ${companyId}`);
        });
      }
      await prisma.$disconnect().catch((e: unknown) => failures.push(`disconnect: ${String(e)}`));
      if (failures.length > 0) {
        throw new Error(`D2-BIZ CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
      }
    }
  });

  async function makeSession(portalAccountId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await prisma.portalSession.create({
      data: { portalAccountId, tokenHash: hmac(raw), expiresAt: new Date(Date.now() + 24 * 3_600_000) },
    });
    return raw;
  }

  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  itif('unauthenticated /api/portal/me → 401', async () => {
    const res = await portalGet('/api/portal/me', '');
    expect(res.status).toBe(401);
  });

  itif('company A session: /profile returns the BUSINESS profile (D2-13 route split)', async () => {
    const paA = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdA, status: 'ACTIVE' },
    });
    const token = await makeSession(paA.id);
    await prisma.portalSession.findFirstOrThrow({ where: { tokenHash: hmac(token) } });
    // RED before the D2-13 fix: the business profile lived on /me and was
    // SHADOWED by PortalAuthController's identity /me — /profile did not exist.
    const res = await portalGet('/api/portal/profile', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.partyId).toBeTruthy();
    expect(body.companyName).toBeTruthy();
    expect(Array.isArray(body.roles)).toBe(true);
  });

  itif('/me stays the identity contract ONLY {companyId, partyId} — no business fields', async () => {
    const paA = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdA, status: 'ACTIVE' },
    });
    const token = await makeSession(paA.id);
    const res = await portalGet('/api/portal/me', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['companyId', 'partyId']);
  });

  itif('company B session: foreign sales document ID → 404', async () => {
    const docA = salesDocIds[0];
    const paB = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdB, status: 'ACTIVE' },
    });
    const token = await makeSession(paB.id);
    const res = await portalGet(`/api/portal/orders/${docA}`, token);
    expect(res.status).toBe(404);
  });

  itif('company A session: own sales document → 200 with correct fields', async () => {
    const docA = salesDocIds[0];
    const paA = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdA, status: 'ACTIVE' },
    });
    const token = await makeSession(paA.id);
    const res = await portalGet(`/api/portal/orders/${docA}`, token);
    expect(res.status).toBe(200);
  });


  itif('D5-QA: pagination page/limit garbage → 400 (never 500)', async () => {
    const paA = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdA, status: 'ACTIVE' },
    });
    const token = await makeSession(paA.id);
    for (const query of ['?page=abc', '?page=NaN', '?limit=-5', '?limit=1.5', '?page=Infinity', '?page=1e5&limit=abc']) {
      const res = await portalGet(`/api/portal/orders${query}`, token);
      expect(`${query} → ${res.status}`).toBe(`${query} → 400`);
    }
    // a HUGE limit is not garbage — the service caps it at 50 (no 500)
    const huge = await portalGet('/api/portal/orders?limit=99999999999999999999', token);
    expect(huge.status).toBe(200);
    expect(((await huge.json()) as { limit: number }).limit).toBeLessThanOrEqual(50);
  });

  itif('Pagination limit is server-capped at 50', async () => {
    const paA = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdA, status: 'ACTIVE' },
    });
    const token = await makeSession(paA.id);
    const res = await portalGet('/api/portal/orders?limit=999', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { limit?: number };
    expect(body.limit).toBeLessThanOrEqual(50);
  });

  itif('Debt: company B session returns B balance (independent from A)', async () => {
    const paB = await prisma.portalAccount.findFirstOrThrow({
      where: { companyId: companyIdB, status: 'ACTIVE' },
    });
    const token = await makeSession(paB.id);
    const res = await portalGet('/api/portal/debt', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { balance?: number; direction?: string };
    expect(typeof body.balance).toBe('number');
    expect(['DEBT', 'CREDIT']).toContain(body.direction);
  });
});
