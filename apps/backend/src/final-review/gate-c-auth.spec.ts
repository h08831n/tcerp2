import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

// CI has NO .env: the zod-validated config requires these before Nest
// instantiation (same pattern as gate-c-http / nest-bootstrap-di).
for (const [key, value] of Object.entries({
  JWT_SECRET: 'gate-c-auth-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'gate-c-auth-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

/**
 * GATE C — Authentication & Session Security over the REAL AppModule with
 * genuine guards (JwtAuthGuard signature+expiry, PermissionsGuard, cookie
 * parser) driven over a real listening socket.
 *
 * Verified behaviors:
 *   - login sets HttpOnly SameSite=Lax cookies; refresh cookie path-scoped
 *     to /api/auth; refresh token stored HASHED.
 *   - refresh ROTATES: the presented token is revoked and a new one issued.
 *   - refresh-token REUSE (a revoked token presented again) revokes ALL of
 *     the user's sessions (detection + audit).
 *   - logout revokes the presented refresh token.
 *   - admin password reset revokes ALL refresh tokens.
 *   - company-membership removal kills subsequent x-company-id requests
 *     (permissions re-resolve from the DB on EVERY request).
 *   - role removal kills the permission on the SAME live token.
 *   - login brute-force lockout after LOGIN_MAX_ATTEMPTS failures.
 *   - expired / garbage access tokens → 401.
 *   - DISABLED user: login + refresh rejected; an ALREADY-ISSUED access
 *     token keeps passing the JwtAuthGuard until expiry (recorded finding —
 *     the guard verifies the signature only; mitigated by the 15m TTL).
 */
describeIntegration('gate-c auth & session security (real guards, real socket)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let A = '';
  const PASSWORD = 'GateC-Auth-passw0rd!';
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  const roleIds: string[] = [];
  const tokenHashesToDelete: string[] = [];
  let seq = 0;

  const usernameMap = new Map<string, string>();
  async function usernameOf(name: string): Promise<string> {
    const cached = usernameMap.get(name);
    if (cached) return cached;
    const row = await prisma.user.findFirstOrThrow({
      where: { username: { startsWith: `gca-${name}-` } },
      orderBy: { createdAt: 'desc' },
      select: { username: true },
    });
    usernameMap.set(name, row.username);
    return row.username;
  }
  async function mkUserSync(name: string, companies: string[], permissionCodes: string[]): Promise<string> {
    const username = `gca-${name}-${Date.now()}-${(seq += 1)}`;
    usernameMap.set(name, username);
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: bcrypt.hashSync(PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
        defaultCompanyId: companies[0] ?? null,
      },
    });
    createdUsers.push(user.id);
    for (const companyId of companies) {
      await prisma.userCompany.create({ data: { userId: user.id, companyId } });
      for (const code of permissionCodes) {
        const permission = await prisma.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
        const role = await prisma.role.create({
          data: { code: `gca-${name}-${code.replace(/\./g, '-')}-${companyId.slice(0, 6)}`, nameFa: code, nameEn: code },
        });
        roleIds.push(role.id);
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
        await prisma.userCompanyRole.create({ data: { userId: user.id, companyId, roleId: role.id } });
      }
    }
    return user.id;
  }

  async function login(identifier: string): Promise<{ accessToken: string; setCookie: string[]; status: number }> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: PASSWORD }),
    });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    let accessToken = '';
    try {
      accessToken = ((await res.json()) as { accessToken?: string }).accessToken ?? '';
    } catch {
      accessToken = '';
    }
    return { accessToken, setCookie, status: res.status };
  }

  function bearer(token: string, companyId: string | null, path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        ...(companyId ? { 'x-company-id': companyId } : {}),
      },
    });
  }

  async function refreshWith(rawCookieToken: string): Promise<{ status: number; setCookie: string[]; body: { accessToken?: string } }> {
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `refresh_token=${rawCookieToken}` },
    });
    return { status: res.status, setCookie: res.headers.getSetCookie?.() ?? [], body: (await res.json()) as { accessToken?: string } };
  }

  function rawTokenFromSetCookie(setCookie: string[]): string {
    const row = setCookie.find((c) => c.startsWith('refresh_token='));
    if (!row) return '';
    return decodeURIComponent(row.split(';')[0].slice('refresh_token='.length));
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    const company = await prisma.company.create({ data: { nameFa: `gca-${Date.now()}`, status: 'ACTIVE' } });
    A = company.id;
    createdCompanies.push(A);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = await moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api');
    // main.ts parity: cookieParser is REQUIRED for /auth/refresh + /logout
    // (they read request.cookies). Without it every refresh → 401.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nestApp.use(require('cookie-parser')());
    await nestApp.init();

    // The seeded admin password in tcerp_test is unknown to this spec —
    // reset it to the known test password (test DB only, documented).
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: 'admin' }, select: { id: true } });
    await prisma.user.update({
      where: { id: admin.id },
      data: { passwordHash: bcrypt.hashSync(PASSWORD, 8), mustChangePassword: false, status: 'ACTIVE' },
    });
    await prisma.userCompany.upsert({
      where: { userId_companyId: { userId: admin.id, companyId: A } },
      create: { userId: admin.id, companyId: A },
      update: {},
    });
    // The seeded 'admin' role carries ALL permissions — assign it in A so
    // users.reset_password passes the permission guard.
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    await prisma.userCompanyRole.upsert({
      where: { userId_companyId_roleId: { userId: admin.id, companyId: A, roleId: adminRole.id } },
      create: { userId: admin.id, companyId: A, roleId: adminRole.id, assignedBy: null },
      update: {},
    });
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
        try {
          await fn();
        } catch (error) {
          failures.push(`${label}: ${String(error)}`);
        }
      };
      await step('refreshTokens', () =>
        prisma.refreshToken.deleteMany({ where: { userId: { in: createdUsers } } }));
      await step('audit(auth)', () =>
        prisma.auditLog.deleteMany({ where: { entityType: 'auth', entityId: { in: createdUsers } } }));
      await step('userPermissionOverrides', () =>
        prisma.userPermissionOverride.deleteMany({ where: { userId: { in: createdUsers } } }));
      await step('userCompanyRoles', () =>
        prisma.userCompanyRole.deleteMany({ where: { userId: { in: createdUsers } } }));
      await step('rolePermissions', () =>
        prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } }));
      await step('roles', () =>
        prisma.role.deleteMany({ where: { id: { in: roleIds } } }));
      await step('userCompanies', () =>
        prisma.userCompany.deleteMany({ where: { userId: { in: createdUsers } } }));
      await step('users', () =>
        prisma.user.deleteMany({ where: { id: { in: createdUsers } } }));
      for (const companyId of createdCompanies) {
        await step(`company(${companyId})`, () =>
          prisma.company.delete({ where: { id: companyId } }).catch(() => undefined));
        await step(`verify(${companyId})`, async () => {
          const left = await prisma.company.count({ where: { id: companyId } });
          if (left !== 0) failures.push(`LEFTOVER company ${companyId}`);
        });
      }
      await step('verify(users)', async () => {
        const left = await prisma.user.count({ where: { id: { in: createdUsers } } });
        if (left !== 0) failures.push(`LEFTOVER users ${left}`);
      });
      await step('verify(roles)', async () => {
        const left = await prisma.role.count({ where: { id: { in: roleIds } } });
        if (left !== 0) failures.push(`LEFTOVER roles ${left}`);
      });
      await prisma.$disconnect().catch((e: unknown) => failures.push(`disconnect: ${String(e)}`));
      if (failures.length > 0) {
        throw new Error(`GATE-C-AUTH CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
      }
    }
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  itif('login sets HttpOnly SameSite=Lax cookies; refresh cookie path-scoped to /api/auth; refresh stored HASHED', async () => {
    const userId = await mkUserSync('cookie', [A], []);
    const username = (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true } })).username;
    const { status, setCookie, accessToken } = await login(username);
    expect(status).toBe(200);
    expect(accessToken).not.toBe('');
    const accessCookie = setCookie.find((c) => c.startsWith('access_token='));
    const refreshCookie = setCookie.find((c) => c.startsWith('refresh_token='));
    expect(accessCookie).toContain('HttpOnly');
    expect(accessCookie).toContain('SameSite=Lax');
    expect(refreshCookie).toContain('HttpOnly');
    expect(refreshCookie).toContain('SameSite=Lax');
    expect(refreshCookie).toContain('Path=/api/auth');
    // Raw refresh token never stored — only its SHA-256 hash.
    const raw = rawTokenFromSetCookie(setCookie);
    const stored = await prisma.refreshToken.findFirstOrThrow({
      where: { userId, revokedAt: null },
    });
    expect(stored.tokenHash).not.toBe(raw);
    expect(stored.tokenHash).toBe(crypto.createHash('sha256').update(raw).digest('hex'));
    tokenHashesToDelete.push(stored.tokenHash);
  });

  itif('expired access token → 401; garbage token → 401', async () => {
    const userId = await mkUserSync('expired', [A], ['parties.view']);
    const expired = jwt.sign({ sub: userId, username: 'x' }, process.env.JWT_SECRET as string, { expiresIn: '-5m' });
    const res = await bearer(expired, A, '/api/parties');
    expect(res.status).toBe(401);
    const garbage = await bearer('not-a-jwt', A, '/api/parties');
    expect(garbage.status).toBe(401);
  });

  itif('refresh rotates; presenting the ROTATED-OUT token revokes ALL sessions', async () => {
    const userId = await mkUserSync('rotate', [A], []);
    const first = await login(await usernameOf('rotate'));
    const raw1 = rawTokenFromSetCookie(first.setCookie);
    expect(raw1).not.toBe('');

    // Rotation: the first refresh issues a NEW token and revokes raw1.
    const second = await refreshWith(raw1);
    expect(second.status).toBe(200);
    const raw2 = rawTokenFromSetCookie(second.setCookie);
    expect(raw2).not.toBe(raw1);

    // Second device logged in with its own refresh token.
    const third = await login(await usernameOf('rotate'));
    const raw3 = rawTokenFromSetCookie(third.setCookie);

    // REUSE of the rotated-out raw1 → reuse detection revokes ALL sessions,
    // including raw3.
    const reuse = await refreshWith(raw1);
    expect(reuse.status).toBe(401);
    const raw3After = await refreshWith(raw3);
    expect(raw3After.status).toBe(401);
    const revoked = await prisma.refreshToken.findMany({ where: { userId, revokedAt: null } });
    expect(revoked).toHaveLength(0);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'auth', entityId: userId, action: 'REFRESH_TOKEN_REUSE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit.reason).toContain('Revoked refresh token');
  });

  itif('logout revokes the presented refresh token', async () => {
    await mkUserSync('logout', [A], []);
    const first = await login(await usernameOf('logout'));
    const raw = rawTokenFromSetCookie(first.setCookie);
    const res = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `refresh_token=${raw}` },
    });
    expect(res.status).toBe(200);
    const after = await refreshWith(raw);
    expect(after.status).toBe(401);
  });

  itif('admin password reset revokes ALL refresh tokens', async () => {
    const userId = await mkUserSync('reset', [A], []);
    const first = await login(await usernameOf('reset'));
    const raw = rawTokenFromSetCookie(first.setCookie);
    await prisma.refreshToken.findFirstOrThrow({ where: { userId, revokedAt: null } });

    // Admin resets the user's password (users.reset_password).
    const admin = await login('admin');
    const res = await fetch(`${baseUrl}/api/users/${userId}/password`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${admin.accessToken}`,
        'x-company-id': A,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'FreshReset-passw0rd!' }),
    });
    expect([200, 201]).toContain(res.status);
    // The old refresh token must be revoked with the reset.
    const after = await refreshWith(raw);
    expect(after.status).toBe(401);
  });

  itif('company-membership removal → subsequent x-company-id requests rejected on the SAME token', async () => {
    const userId = await mkUserSync('removal', [A], ['parties.view']);
    const tok = await login(await usernameOf('removal'));
    const before = await bearer(tok.accessToken, A, '/api/parties');
    expect(before.status).toBe(200);

    await prisma.userCompany.deleteMany({ where: { userId, companyId: A } });

    const after = await bearer(tok.accessToken, A, '/api/parties');
    expect(after.status).toBe(403); // permissions re-resolve per request
  });

  itif('role removal → the SAME live token immediately loses the permission', async () => {
    const userId = await mkUserSync('revoke', [A], ['parties.view']);
    const tok = await login(await usernameOf('revoke'));
    const before = await bearer(tok.accessToken, A, '/api/parties');
    expect(before.status).toBe(200);

    await prisma.userCompanyRole.deleteMany({ where: { userId, companyId: A } });

    const after = await bearer(tok.accessToken, A, '/api/parties');
    expect(after.status).toBe(403);
  });

  itif('DISABLED user: login + refresh rejected AND the live token loses access from the NEXT request', async () => {
    const userId = await mkUserSync('disable', [A], ['parties.view']);
    const tok = await login(await usernameOf('disable'));
    const before = await bearer(tok.accessToken, A, '/api/parties');
    expect(before.status).toBe(200); // active user works

    // Deactivate.
    await prisma.user.update({ where: { id: userId }, data: { status: 'DISABLED' } });

    const loginRes = await login(await usernameOf('disable'));
    expect(loginRes.status).toBe(403); // login blocked

    // R6-S1 (owner-approved policy): a DISABLED user must lose access from
    // the FIRST subsequent request — even while the old access token is
    // still signature-valid. 401/403 both satisfy "rejected"; 200 = BUG.
    const live = await bearer(tok.accessToken, A, '/api/parties');
    expect([401, 403]).toContain(live.status);
  });

  itif('brute-force lockout: 5 consecutive failures lock the account; correct password also rejected while locked', async () => {
    const userId = await mkUserSync('brute', [A], []);
    const username = await usernameOf('brute');
    let last = 0;
    for (let i = 0; i < 5; i += 1) {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: username, password: 'wrong-password' }),
      });
      last = res.status;
    }
    expect([401, 403]).toContain(last);
    const locked = await login(username);
    expect(locked.status).toBe(403); // even the CORRECT password is rejected
    // Unlock from the DB (the admin flow), then login works again.
    await prisma.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
    const recovered = await login(username);
    expect(recovered.status).toBe(200);
  });
});
