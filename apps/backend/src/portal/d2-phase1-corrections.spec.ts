import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';
import { randomBytes, randomUUID, createHmac } from 'crypto';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'd2fix-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'd2fix-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  // The IP-hourly dimension (default 10/hour per docs/15 §rate limit) is
  // shared by every integration spec booted from loopback — a HIGH cap here
  // keeps this file's own budget independent; the MOBILE 1/min policy runs
  // at its production default and is exercised for real below.
  PORTAL_OTP_IP_PER_HOUR: '1000',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const ADMIN_PASSWORD = 'D2-Fix-admin-passw0rd!';

/**
 * Gate D-2 Phase 1 corrections (D2-10..D2-13) — real HTTP over the REAL
 * AppModule with genuine guards.
 *
 * D2-10: request-otp is MOBILE-ONLY (docs/15 §API contract) — no companyId,
 *        real accounts always get the SMS, uniform response (no enumeration).
 * D2-11: server-side ATOMIC rate limit (mobile 1/min by default) BEFORE the
 *        challenge row is created — a limited request leaves NO row.
 * D2-12: select-company consumes the pending token, validates the account and
 *        creates the session inside ONE transaction — validation failures do
 *        NOT burn the token; concurrent selects cannot double-create.
 * D2-13: GET /api/portal/me has exactly ONE contract (session identity);
 *        session/Company/Party status + CSRF layers + OTP replay over HTTP.
 */
describeIntegration('d2-phase1-corrections (real AppModule + portal guards)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let A = '';
  let B = '';
  let adminToken = '';
  const marker = `d2fix-${Date.now()}`;
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  const portalAccountIds: string[] = [];
  const partyIds: string[] = [];
  const otpMobiles: string[] = [];
  let foreignPendingId = '';
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  function hmac(data: string): string {
    return createHmac('sha256', process.env.JWT_SECRET ?? 'd2fix-jwt-secret-0123456789').update(data).digest('hex');
  }

  function portalPost(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  function portalGet(path: string, cookie: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: { Cookie: cookie },
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const c of [`d2fixA-${marker}`, `d2fixB-${marker}`]) {
      const company = await prisma.company.create({ data: { nameFa: c, status: 'ACTIVE' } });
      if (A === '') A = company.id;
      else B = company.id;
      createdCompanies.push(company.id);
    }

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const adminUser = await prisma.user.create({
      data: {
        username: `d2fix-admin-${marker}`,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    createdUsers.push(adminUser.id);
    await prisma.userCompany.create({ data: { userId: adminUser.id, companyId: A } });
    await prisma.userCompany.create({ data: { userId: adminUser.id, companyId: B } });
    await prisma.userCompanyRole.create({ data: { userId: adminUser.id, companyId: A, roleId: adminRole.id } });
    await prisma.userCompanyRole.create({ data: { userId: adminUser.id, companyId: B, roleId: adminRole.id } });

    // Boot the REAL app — WITH the production global filter so the error
    // envelope under test is the one production actually serves.
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

    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: adminUser.username, password: ADMIN_PASSWORD }),
    });
    adminToken = ((await res.json()) as { accessToken?: string }).accessToken ?? '';
    expect(adminToken).toBeTruthy();

    // D2-15 protective fixture: a PendingSelection owned by NO suite account.
    // If any cleanup uses an unscoped deleteMany, this row disappears and the
    // suite fails loudly — before and after every test.
    const foreign = await prisma.portalPendingSelection.create({
      data: {
        tokenHash: 'f'.repeat(64),
        portalAccountIds: ['00000000-0000-4000-8000-00000000d2f1'],
        consumed: false,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    foreignPendingId = foreign.id;
  });

  afterAll(async () => {
    await app?.close().catch((e: unknown) => {
      throw new Error(`app.close: ${String(e)}`);
    });
    if (prisma) {
      const failures: string[] = [];
      const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
        try {
          await fn();
        } catch (error) {
          failures.push(`${label}: ${String(error)}`);
        }
      };
      await step('portalOtpCodes', () =>
        prisma.portalOtpCode.deleteMany({ where: { mobile: { in: otpMobiles } } }));
      await step('otpSmsMessages', () =>
        prisma.smsMessage.deleteMany({ where: { to: { in: otpMobiles }, idempotencyKey: { startsWith: 'portal-otp:' } } }));
      await step('portalSessions', () =>
        prisma.portalSession.deleteMany({ where: { portalAccountId: { in: portalAccountIds } } }));
      await step('portalPendingSelections', () =>
        prisma.portalPendingSelection.deleteMany({ where: { portalAccountIds: { hasSome: portalAccountIds } } }));
      await step('portalAccounts', () =>
        prisma.portalAccount.deleteMany({ where: { id: { in: portalAccountIds } } }));
      await step('parties', () =>
        prisma.party.deleteMany({ where: { id: { in: partyIds } } }));
      await step('users', () =>
        prisma.user.deleteMany({ where: { id: { in: createdUsers } } }));
      // D2-15 protective fixture: the FOREIGN pending selection belongs to no
      // suite-owned account — every cleanup above must have left it intact.
      await step('foreignPendingSelectionSurvived', async () => {
        const still = await prisma.portalPendingSelection.findUnique({ where: { id: foreignPendingId } });
        if (!still) throw new Error('FOREIGN pending selection was DELETED by suite cleanup');
        await prisma.portalPendingSelection.delete({ where: { id: foreignPendingId } });
      });
      for (const companyId of createdCompanies) {
        await step(`company(${companyId})`, async () => {
          await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
          const left = await prisma.company.count({ where: { id: companyId } });
          if (left !== 0) failures.push(`LEFTOVER company ${companyId}`);
        });
      }
      await prisma.$disconnect().catch((e: unknown) => failures.push(`disconnect: ${String(e)}`));
      if (failures.length > 0) {
        throw new Error(`D2-FIX CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
      }
    }
  });

  async function createPortalAccount(companyId: string, partyId: string, mobile: string, status: 'ACTIVE' | 'PENDING' | 'SUSPENDED' = 'ACTIVE'): Promise<string> {
    const res = await fetch(`${baseUrl}/api/portalaccounts`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'x-company-id': companyId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ companyId, partyId, verifiedMobile: mobile, status }),
    });
    if (![200, 201].includes(res.status)) {
      throw new Error(`portal-account create failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { id?: string };
    const id = body.id ?? '';
    portalAccountIds.push(id);
    return id;
  }

  async function newParty(companyId: string, label: string): Promise<string> {
    const party = await prisma.party.create({
      data: { companyId, type: 'COMPANY', nameFa: `d2fix-${label} ${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    partyIds.push(party.id);
    return party.id;
  }

  async function requestOtp(mobile: string, extraHeaders: Record<string, string> = {}): Promise<{ res: Response; body: { challengeId?: string; sent?: boolean; code?: string; message?: string } }> {
    otpMobiles.push(mobile);
    const res = await portalPost('/api/portal/request-otp', { mobile }, undefined, extraHeaders);
    return { res, body: (await res.json()) as { challengeId?: string; sent?: boolean; code?: string; message?: string } };
  }

  async function readOtpCodeFromSms(mobile: string): Promise<string> {
    const smsMessage = await prisma.smsMessage.findFirstOrThrow({
      where: { to: mobile, idempotencyKey: { startsWith: 'portal-otp:' } },
      orderBy: { createdAt: 'desc' },
    });
    const code = smsMessage.text.match(/(\d{6})/)?.[1];
    expect(code).toBeTruthy();
    return code!;
  }

  async function challengeCount(mobile: string): Promise<number> {
    return prisma.portalOtpCode.count({ where: { mobile } });
  }

  // Run-to-run interference guard: back-to-back jest runs reuse the same
  // fixed mobile numbers, and the 1/min mobile limit would trip across runs
  // (observed 53s apart). Each test starts with a fresh challenge budget —
  // scoped STRICTLY to the mobiles this suite actually used (D2-15: no
  // prefix/global deletes; a foreign fixture must survive).
  beforeEach(async () => {
    if (!prisma) return;
    await prisma.portalOtpCode.deleteMany({ where: { mobile: { in: otpMobiles } } });
  });

  // ---------------------------------------------------------------- D2-10

  itif('D2-10: request-otp with ONLY mobile (no companyId) sends the SMS for a real account', async () => {
    const mobile = '09120002101';
    await createPortalAccount(A, await newParty(A, 'd2-10'), mobile);

    const { res, body } = await requestOtp(mobile);
    expect(res.status).toBe(200);
    expect(body.challengeId).toBeTruthy();

    // The SMS MUST be enqueued — a real account must never be left waiting
    // for a code that was never sent (the mobile-only contract, docs/15).
    const code = await readOtpCodeFromSms(mobile);

    // verify-otp is mobile-only too and yields a session.
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: body.challengeId, code });
    expect(verifyRes.status).toBe(200);
    const sessionCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='));
    expect(sessionCookie).toBeTruthy();
    const me = await portalGet('/api/portal/me', sessionCookie!.split(';')[0]);
    expect(me.status).toBe(200);
  });

  itif('D2-10: response shape is uniform {challengeId, sent:true} for known AND unknown mobiles', async () => {
    const known = '09120002102';
    await createPortalAccount(A, await newParty(A, 'd2-10u'), known);
    const okRes = await requestOtp(known);
    expect(okRes.res.status).toBe(200);
    expect(okRes.body.challengeId).toBeTruthy();
    expect(okRes.body.sent).toBe(true);

    const unknown = '09129990210';
    const unknownRes = await requestOtp(unknown);
    expect(unknownRes.res.status).toBe(200);
    expect(unknownRes.body.challengeId).toBeTruthy();
    expect(unknownRes.body.sent).toBe(true); // identical shape — no enumeration
  });

  // ---------------------------------------------------------------- D2-11

  itif('D2-11: second request-otp for the SAME mobile within 60s → 429 OTP_RATE_LIMITED', async () => {
    const mobile = '09120002201';
    await createPortalAccount(A, await newParty(A, 'd2-11'), mobile);

    const first = await requestOtp(mobile);
    expect(first.res.status).toBe(200);

    const second = await requestOtp(mobile);
    expect(second.res.status).toBe(429);
    expect(second.body.code).toBe('OTP_RATE_LIMITED');
  });

  itif('D2-11: a rate-limited request does NOT create a challenge row', async () => {
    const mobile = '09120002202';
    await createPortalAccount(A, await newParty(A, 'd2-11r'), mobile);

    await requestOtp(mobile); // allowed → 1 row
    await requestOtp(mobile); // limited → NO additional row
    await requestOtp(mobile); // still limited → still NO row

    expect(await challengeCount(mobile)).toBe(1);
  });

  itif('D2-11: a DIFFERENT mobile from the same IP is not blocked by the first mobile limit', async () => {
    const m1 = '09120002203';
    const m2 = '09120002204';
    await createPortalAccount(A, await newParty(A, 'd2-11x'), m1);

    await requestOtp(m1);
    const other = await requestOtp(m2);
    expect(other.res.status).toBe(200);
  });

  itif('D2-11: the challenge row records the client IP (IP dimension plumbing)', async () => {
    const mobile = '09120002205';
    await createPortalAccount(A, await newParty(A, 'd2-11ip'), mobile);
    await requestOtp(mobile);
    const row = await prisma.portalOtpCode.findFirstOrThrow({
      where: { mobile },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.ip).toBeTruthy();
    expect(row.ip).toContain('127.0.0.1');
  });

  // ---------------------------------------------------------------- D2-12

  itif('D2-12: selecting a SUSPENDED account → 403 PORTAL_ACCOUNT_SUSPENDED and the pending token is NOT burned', async () => {
    const mobile = '09120002301';
    const paA = await createPortalAccount(A, await newParty(A, 'd2-12A'), mobile);
    const paB = await createPortalAccount(B, await newParty(B, 'd2-12B'), mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    expect(verifyRes.status).toBe(200);
    const pendingCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_pending='))?.split(';')[0];
    expect(pendingCookie).toBeTruthy();

    // Suspend A between verify and select.
    await prisma.portalAccount.update({ where: { id: paA }, data: { status: 'SUSPENDED' } });

    const selectA = await portalPost('/api/portal/select-company', { portalAccountId: paA }, pendingCookie);
    expect(selectA.status).toBe(403);
    const selectABody = (await selectA.json()) as { message?: string };
    expect(selectABody.message).toBe('PORTAL_ACCOUNT_SUSPENDED');

    // The token must SURVIVE the failed selection — the customer can still
    // pick company B without re-running the whole OTP flow.
    const selectB = await portalPost('/api/portal/select-company', { portalAccountId: paB }, pendingCookie);
    expect(selectB.status).toBe(200);
    const me = await portalGet('/api/portal/me', selectB.headers.getSetCookie().find((c) => c.startsWith('portal_session='))!.split(';')[0]);
    expect(((await me.json()) as { companyId: string }).companyId).toBe(B);
  });

  itif('D2-12: selecting an account OUTSIDE the verified whitelist → 403 PORTAL_ACCOUNT_NOT_ALLOWED', async () => {
    // The mobile owns accounts A + B (multi-account → PENDING_SELECTION);
    // `foreign` is a portal account the mobile does NOT own.
    const mobile = '09120002302';
    await createPortalAccount(A, await newParty(A, 'd2-12w'), mobile);
    await createPortalAccount(B, await newParty(B, 'd2-12w2'), mobile);
    const foreign = await createPortalAccount(B, await newParty(B, 'd2-12f'), '09120002399');

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const pendingCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_pending='))?.split(';')[0];
    expect(pendingCookie).toBeTruthy();

    const res = await portalPost('/api/portal/select-company', { portalAccountId: foreign }, pendingCookie);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { message?: string }).message).toBe('PORTAL_ACCOUNT_NOT_ALLOWED');
  });

  itif('D2-12: two CONCURRENT select-company calls → exactly one session, loser gets 401', async () => {
    const mobile = '09120002303';
    const paA = await createPortalAccount(A, await newParty(A, 'd2-12c1'), mobile);
    await createPortalAccount(B, await newParty(B, 'd2-12c2'), mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const pendingCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_pending='))?.split(';')[0];
    expect(pendingCookie).toBeTruthy();

    const [r1, r2] = await Promise.all([
      portalPost('/api/portal/select-company', { portalAccountId: paA }, pendingCookie),
      portalPost('/api/portal/select-company', { portalAccountId: paA }, pendingCookie),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 401]);
    const sessions = await prisma.portalSession.count({ where: { portalAccountId: paA } });
    expect(sessions).toBe(1);
  });

  itif('D2-12: select-company WITHOUT the pending cookie → 401 SELECTION_EXPIRED (never 500)', async () => {
    const res = await portalPost('/api/portal/select-company', { portalAccountId: randomBytes(16).toString('hex') });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message?: string }).message).toBe('SELECTION_EXPIRED');
  });

  itif('D2-12: EXPIRED pending token → 401 SELECTION_EXPIRED', async () => {
    const raw = randomBytes(48).toString('hex');
    await prisma.portalPendingSelection.create({
      data: { tokenHash: hmac(raw), portalAccountIds: [], consumed: false, expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await portalPost('/api/portal/select-company', { portalAccountId: randomBytes(16).toString('hex') }, `portal_pending=${raw}`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message?: string }).message).toBe('SELECTION_EXPIRED');
  });

  // ---------------------------------------------------------------- D2-13

  itif('D2-13: GET /api/portal/me returns EXACTLY the session-identity contract {companyId, partyId}', async () => {
    const mobile = '09120002401';
    const partyId = await newParty(A, 'd2-13me');
    await createPortalAccount(A, partyId, mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const sessionCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='))?.split(';')[0];
    expect(sessionCookie).toBeTruthy();

    const me = await portalGet('/api/portal/me', sessionCookie!);
    expect(me.status).toBe(200);
    const body = (await me.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['companyId', 'partyId']);
    expect(body.companyId).toBe(A);
    expect(body.partyId).toBe(partyId);
  });

  itif('D2-16: Sec-Fetch-Site: cross-site request → 403 and NO database change (docs/17 §5)', async () => {
    const { res, body } = await requestOtp('09120002402', {
      'Sec-Fetch-Site': 'cross-site',
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(body.message).toBe('CROSS_SITE_REJECTED');
    // The rejected request must not have created a challenge row.
    expect(await challengeCount('09120002402')).toBe(0);
  });

  itif('D2-16: ALLOWED Origin (CORS_ORIGINS whitelist) without Sec-Fetch-Site is accepted', async () => {
    const { res, body } = await requestOtp('09120002403', {
      Origin: 'http://localhost:3000',
    });
    expect(res.status).toBe(200);
    expect(body.challengeId).toBeTruthy();
  });

  itif('D2-16: DISALLOWED Origin → 403 OriginNotAllowed and NO database change', async () => {
    const { res, body } = await requestOtp('09120002404', {
      Origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect(body.message).toBe('ORIGIN_NOT_ALLOWED');
    expect(await challengeCount('09120002404')).toBe(0);
  });

  itif('D2-16: request with NO Origin header → accepted (documented non-browser policy)', async () => {
    // Node fetch/curl/server-to-server integrations send no Origin. This
    // policy is explicit: absent Origin is NOT cross-site evidence, and
    // SameSite=Lax keeps the session cookie off cross-site browsers.
    const { res, body } = await requestOtp('09120002410');
    expect(res.status).toBe(200);
    expect(body.challengeId).toBeTruthy();
  });

  itif('D2-15: the FOREIGN pending-selection fixture survives mid-suite (unscoped-delete tripwire)', async () => {
    const still = await prisma.portalPendingSelection.findUnique({ where: { id: foreignPendingId } });
    expect(still).not.toBeNull();
    expect(still!.consumed).toBe(false);
  });

  itif('D2-13: OTP replay after a successful verify → 401 INVALID_OTP', async () => {
    const mobile = '09120002405';
    await createPortalAccount(A, await newParty(A, 'd2-13r'), mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const challengeId = (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId;

    const first = await portalPost('/api/portal/verify-otp', { mobile, challengeId, code });
    expect(first.status).toBe(200);
    const replay = await portalPost('/api/portal/verify-otp', { mobile, challengeId, code });
    expect(replay.status).toBe(401);
    expect(((await replay.json()) as { message?: string }).message).toBe('INVALID_OTP');
  });

  itif('D2-13: FORGED session cookie → 401', async () => {
    const res = await portalGet('/api/portal/me', 'portal_session=deadbeef'.repeat(6));
    expect(res.status).toBe(401);
  });

  itif('D2-13: EXPIRED session → 401 on the next request', async () => {
    const mobile = '09120002406';
    const paId = await createPortalAccount(A, await newParty(A, 'd2-13exp'), mobile);
    const raw = randomBytes(48).toString('hex');
    await prisma.portalSession.create({
      data: { portalAccountId: paId, tokenHash: hmac(raw), expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await portalGet('/api/portal/me', `portal_session=${raw}`);
    expect(res.status).toBe(401);
  });

  itif('D2-13: SUSPENDED PortalAccount → 403 on the next request (immediate revocation)', async () => {
    const mobile = '09120002407';
    const paId = await createPortalAccount(A, await newParty(A, 'd2-13sus'), mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const sessionCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='))?.split(';')[0];
    expect(sessionCookie).toBeTruthy();
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(200);

    await prisma.portalAccount.update({ where: { id: paId }, data: { status: 'SUSPENDED' } });
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(403);
  });

  itif('D2-13: SUSPENDED Company → 403 on the next request (restored afterwards)', async () => {
    const mobile = '09120002408';
    await createPortalAccount(A, await newParty(A, 'd2-13co'), mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const sessionCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='))?.split(';')[0];
    expect(sessionCookie).toBeTruthy();
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(200);

    await prisma.company.update({ where: { id: A }, data: { status: 'SUSPENDED' } });
    try {
      expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(403);
    } finally {
      await prisma.company.update({ where: { id: A }, data: { status: 'ACTIVE' } });
    }
  });

  itif('D2-13: ARCHIVED Party → 403 on the next request', async () => {
    const mobile = '09120002409';
    const partyId = await newParty(A, 'd2-13arch');
    await createPortalAccount(A, partyId, mobile);

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const sessionCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='))?.split(';')[0];
    expect(sessionCookie).toBeTruthy();
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(200);

    await prisma.party.update({ where: { id: partyId }, data: { archivedAt: new Date() } });
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(403);
  });

  itif('D2-13: request-otp WITHOUT mobile → 422 (never 500)', async () => {
    const res = await portalPost('/api/portal/request-otp', {});
    expect(res.status).toBe(422);
  });

  // ---------------------------------------------------------------- D2-18

  itif('D2-18: PENDING_SELECTION response carries the SAFE allowed options (id + company name only)', async () => {
    const mobile = '09120002501';
    const paA = await createPortalAccount(A, await newParty(A, 'd2-18A'), mobile);
    const paB = await createPortalAccount(B, await newParty(B, 'd2-18B'), mobile);
    const companyAName = (await prisma.company.findUniqueOrThrow({ where: { id: A }, select: { nameFa: true } })).nameFa;
    const companyBName = (await prisma.company.findUniqueOrThrow({ where: { id: B }, select: { nameFa: true } })).nameFa;

    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    expect(verifyRes.status).toBe(200);
    const body = (await verifyRes.json()) as {
      sessionActive: boolean;
      pendingSelection: Array<{ portalAccountId?: string; companyName?: string }>;
    };
    expect(body.sessionActive).toBe(false);

    // The client must be able to ACTUALLY choose: the response carries the
    // allowed options (docs/17 §1) — id + display name, nothing internal.
    expect(Array.isArray(body.pendingSelection)).toBe(true);
    expect(body.pendingSelection).toHaveLength(2);
    const ids = body.pendingSelection.map((o) => o.portalAccountId).sort();
    expect(ids).toEqual([paA, paB].sort());
    const names = body.pendingSelection.map((o) => o.companyName).sort();
    expect(names).toEqual([companyAName, companyBName].sort());
    for (const option of body.pendingSelection) {
      expect(Object.keys(option).sort()).toEqual(['companyName', 'portalAccountId']);
    }

    // Selecting the option the user picked binds the session to THAT company.
    const selectRes = await portalPost('/api/portal/select-company', { portalAccountId: paB }, verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_pending='))?.split(';')[0]);
    expect(selectRes.status).toBe(200);
    const me = await portalGet('/api/portal/me', selectRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='))!.split(';')[0]);
    expect(((await me.json()) as { companyId: string }).companyId).toBe(B);
  });

  itif('D2-18: NO company options are disclosed before a VALID OTP', async () => {
    // Wrong code → uniform INVALID_OTP and no option list.
    const mobile = '09120002502';
    await createPortalAccount(A, await newParty(A, 'd2-18n'), mobile);
    await createPortalAccount(B, await newParty(B, 'd2-18n2'), mobile);
    await requestOtp(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code: '000000' });
    expect(verifyRes.status).toBe(401);
    const body = (await verifyRes.json()) as { pendingSelection?: unknown };
    expect(body.pendingSelection).toBeUndefined();
  });

  // ---------------------------------------------------------------- D2-14

  itif('D2-14: creating a PortalAccount with a party from ANOTHER company → 422 PORTAL_PARTY_NOT_IN_COMPANY', async () => {
    const partyB = await newParty(B, 'd2-14cross');
    const res = await fetch(`${baseUrl}/api/portalaccounts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'x-company-id': A, 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: A, partyId: partyB, verifiedMobile: '09120002601', status: 'ACTIVE' }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message?: string }).message).toBe('PORTAL_PARTY_NOT_IN_COMPANY');
    // Nothing must have been persisted.
    expect(await prisma.portalAccount.count({ where: { companyId: A, partyId: partyB } })).toBe(0);
  });

  itif('D2-14: a CORRUPT record (party of another company) is rejected by PortalAuthGuard → 403', async () => {
    // Simulate pre-existing inconsistent data written directly to the DB.
    const partyB = await newParty(B, 'd2-14corrupt');
    const corrupt = await prisma.portalAccount.create({
      data: { companyId: A, partyId: partyB, verifiedMobile: '09120002602', status: 'ACTIVE' },
    });
    portalAccountIds.push(corrupt.id);
    const raw = randomBytes(48).toString('hex');
    await prisma.portalSession.create({
      data: { portalAccountId: corrupt.id, tokenHash: hmac(raw), expiresAt: new Date(Date.now() + 3_600_000) },
    });

    const me = await portalGet('/api/portal/me', `portal_session=${raw}`);
    expect(me.status).toBe(403);
  });

  // ------------------------------------------- OTP/session contract review

  itif('CONTRACT: resending OTP invalidates the previous challenge (no two live codes)', async () => {
    const mobile = '09120002701';
    await createPortalAccount(A, await newParty(A, 'd2-resend'), mobile);

    // Simulate a challenge issued 61s ago (outside the 1/min window) with a
    // known code, so the resend is a legitimate request under the policy.
    const oldChallengeId = randomUUID();
    const oldCode = '123456';
    await prisma.portalOtpCode.create({
      data: {
        mobile,
        challengeId: oldChallengeId,
        codeHmac: hmac(oldChallengeId + oldCode),
        expiresAt: new Date(Date.now() + 120_000),
        createdAt: new Date(Date.now() - 61_000),
      },
    });
    otpMobiles.push(mobile);

    // Resend → new challenge.
    const { res, body } = await requestOtp(mobile);
    expect(res.status).toBe(200);
    expect(body.challengeId).toBeTruthy();

    // The OLD code must no longer verify.
    const oldVerify = await portalPost('/api/portal/verify-otp', { mobile, challengeId: oldChallengeId, code: oldCode });
    expect(oldVerify.status).toBe(401);
    expect(((await oldVerify.json()) as { message?: string }).message).toBe('INVALID_OTP');

    // The NEW challenge still verifies.
    const newCode = await readOtpCodeFromSms(mobile);
    const newVerify = await portalPost('/api/portal/verify-otp', { mobile, challengeId: body.challengeId, code: newCode });
    expect(newVerify.status).toBe(200);
  });

  itif('CONTRACT: verify that cannot create a session does NOT consume the code (recoverable)', async () => {
    const mobile = '09120002702';
    const paId = await createPortalAccount(A, await newParty(A, 'd2-recover'), mobile);
    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const challengeId = (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId;

    // The account is suspended between request and verify — session creation
    // cannot succeed, but the code must NOT be burned.
    await prisma.portalAccount.update({ where: { id: paId }, data: { status: 'SUSPENDED' } });
    const failed = await portalPost('/api/portal/verify-otp', { mobile, challengeId, code });
    expect(failed.status).toBe(401);
    expect(((await failed.json()) as { message?: string }).message).toBe('INVALID_OTP');
    const row = await prisma.portalOtpCode.findUniqueOrThrow({ where: { challengeId } });
    expect(row.consumed).toBe(false); // ← RED today: the CAS burns the code

    // Recovery: once the account is ACTIVE again, the SAME code verifies.
    await prisma.portalAccount.update({ where: { id: paId }, data: { status: 'ACTIVE' } });
    const retry = await portalPost('/api/portal/verify-otp', { mobile, challengeId, code });
    expect(retry.status).toBe(200);
    expect(retry.headers.getSetCookie().find((c) => c.startsWith('portal_session='))).toBeTruthy();
  });

  itif('CONTRACT: POST /api/portal/logout revokes the session and clears the cookie', async () => {
    const mobile = '09120002703';
    const paId = await createPortalAccount(A, await newParty(A, 'd2-logout'), mobile);
    await requestOtp(mobile);
    const code = await readOtpCodeFromSms(mobile);
    const verifyRes = await portalPost('/api/portal/verify-otp', { mobile, challengeId: (await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile }, orderBy: { createdAt: 'desc' } })).challengeId, code });
    const sessionCookie = verifyRes.headers.getSetCookie().find((c) => c.startsWith('portal_session='))?.split(';')[0];
    expect(sessionCookie).toBeTruthy();
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(200);

    const logout = await fetch(`${baseUrl}/api/portal/logout`, { method: 'POST', headers: { Cookie: sessionCookie! } });
    expect(logout.status).toBe(200);

    // The stored session is revoked (row gone) and the cookie is cleared.
    const tokenHash = hmac(sessionCookie!.split('=')[1]);
    expect(await prisma.portalSession.count({ where: { tokenHash } })).toBe(0);
    const cleared = logout.headers.getSetCookie().find((c) => c.startsWith('portal_session='));
    expect(cleared).toBeTruthy();
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/i);
    expect((await portalGet('/api/portal/me', sessionCookie!)).status).toBe(401);
  });

  // --------------------------------------- D2-11 IP race (kept LAST: it
  // temporarily saturates the IP budget with seeded rows)

  itif('D2-11: CONCURRENT different mobiles, same IP at 999/1000 → exactly ONE is accepted', async () => {
    const seedIds: string[] = [];
    try {
      // Determine the exact IP value real requests record.
      const probe = '09120002800';
      await createPortalAccount(A, await newParty(A, 'd2-11probe'), probe);
      const { res: probeRes } = await requestOtp(probe);
      expect(probeRes.status).toBe(200);
      const probeRow = await prisma.portalOtpCode.findFirstOrThrow({ where: { mobile: probe }, orderBy: { createdAt: 'desc' } });
      const ip = probeRow.ip;
      expect(ip).toBeTruthy();
      // The probe row itself consumes budget — remove it precisely so the
      // seed below lands on exactly 999.
      await prisma.portalOtpCode.delete({ where: { challengeId: probeRow.challengeId } });

      // Fill the IP budget to exactly 999/1000 (PORTAL_OTP_IP_PER_HOUR=1000
      // in tests): seed the DIFFERENCE so rows created by earlier tests in
      // this run do not skew the count. Seed rows use a dedicated namespace
      // no real flow can produce.
      const current = await prisma.portalOtpCode.count({ where: { ip: ip! } });
      const seedIdsNew = Array.from({ length: Math.max(0, 999 - current) }, () => randomUUID());
      seedIds.push(...seedIdsNew);
      await prisma.portalOtpCode.createMany({
        data: seedIdsNew.map((challengeId, i) => ({
          mobile: `ip-race-seed-${i}`,
          challengeId,
          codeHmac: '0'.repeat(64),
          ip: ip!,
          expiresAt: new Date(Date.now() + 120_000),
        })),
      });
      expect(await prisma.portalOtpCode.count({ where: { ip: ip! } })).toBe(999);

      const m1 = '09120002801';
      const m2 = '09120002802';
      await createPortalAccount(A, await newParty(A, 'd2-11race1'), m1);
      await createPortalAccount(A, await newParty(A, 'd2-11race2'), m2);
      otpMobiles.push(m1, m2);

      // Two CONCURRENT requests, different mobiles, same IP, one slot left.
      const [r1, r2] = await Promise.all([
        portalPost('/api/portal/request-otp', { mobile: m1 }),
        portalPost('/api/portal/request-otp', { mobile: m2 }),
      ]);
      const statuses = [r1.status, r2.status].sort();
      expect(statuses).toEqual([200, 429]); // ← RED today: both pass the race
      expect(await challengeCount(m1) + await challengeCount(m2)).toBe(1);
    } finally {
      // Release the seeded budget NO MATTER HOW the test fails — a leaked
      // seed would saturate the IP budget for every later run.
      if (seedIds.length > 0) {
        await prisma.portalOtpCode.deleteMany({ where: { challengeId: { in: seedIds } } });
      }
    }
  });
});
