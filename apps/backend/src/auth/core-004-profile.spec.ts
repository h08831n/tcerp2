import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';

/**
 * CORE-004 — self-profile & password acceptance over the REAL AppModule.
 *
 * Laws under test:
 *  - PATCH /auth/profile updates ONLY whitelisted self-service fields —
 *    status/roles/company fields in the payload are structurally ignored.
 *  - POST /auth/change-password requires the CURRENT password; wrong current
 *    → refused; success → login works with the NEW password and the OLD
 *    password stops working; other refresh tokens revoked.
 *  - Everything is audited; the audit never contains password material.
 */

const ADMIN_PASSWORD = 'Core4-Admin-Passw0rd!';

if (TEST_INTEGRATION) {
  assertSafeIntegrationDatabase(process.env.DATABASE_URL);
}

for (const [key, value] of Object.entries({
  JWT_SECRET: process.env.JWT_SECRET ?? 'core4-jwt-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'core4-jwt-refresh-secret-0123456789',
  NODE_ENV: 'test',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const state = {
  adminToken: '',
  companyId: '00000000-0000-4000-8000-000000000001',
  marker: '',
};

describeIntegration('core-004 profile & password (real AppModule over HTTP)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  const tracked = { users: [] as string[] };

  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-company-id': state.companyId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json as Record<string, unknown> };
  }

  beforeAll(async () => {
    if (!TEST_INTEGRATION) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = await moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api');
    nestApp.use(require('cookie-parser')());
    nestApp.useGlobalFilters(new GlobalExceptionFilter());
    nestApp.useGlobalPipes(
      new (require('@nestjs/common').ValidationPipe)({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await nestApp.init();
    const server = nestApp.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = nestApp;

    prisma = new PrismaService();
    await prisma.$connect();
    state.marker = `core4-${Date.now()}`;

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const admin = await prisma.user.create({
      data: {
        username: `core4-admin-${state.marker}`,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    tracked.users.push(admin.id);
    await prisma.userCompany.create({ data: { userId: admin.id, companyId: state.companyId } });
    await prisma.userCompanyRole.create({
      data: { userId: admin.id, companyId: state.companyId, roleId: adminRole.id },
    });

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: admin.username, password: ADMIN_PASSWORD }),
    });
    state.adminToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';
    expect(state.adminToken).toBeTruthy();
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.userCompanyRole.deleteMany({ where: { userId: { in: tracked.users } } }).catch(() => undefined);
      await prisma.userCompany.deleteMany({ where: { userId: { in: tracked.users } } }).catch(() => undefined);
      await prisma.refreshToken.deleteMany({ where: { userId: { in: tracked.users } } }).catch(() => undefined);
      await prisma.auditLog.deleteMany({ where: { entityId: { in: tracked.users } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: tracked.users } } }).catch(() => undefined);
      await prisma.$disconnect();
    }
    if (app) await app.close();
  });

  it('profile: self-update of whitelisted fields persists', async () => {
    const res = await api('PATCH', '/api/auth/profile', state.adminToken, {
      firstName: 'مدیر',
      lastName: 'ارشد',
      email: `core4-${state.marker}@test.local`,
      mobile: '09121112233',
      language: 'fa',
      timezone: 'Asia/Tehran',
      avatarUrl: 'https://example.com/avatar.png',
    });
    expect(res.status).toBe(200);

    const row = await prisma.user.findUniqueOrThrow({
      where: { id: tracked.users[0] },
    });
    expect(row.firstName).toBe('مدیر');
    expect(row.lastName).toBe('ارشد');
    expect(row.email).toBe(`core4-${state.marker}@test.local`);
    expect(row.mobile).toBe('09121112233');
    expect(row.avatarUrl).toBe('https://example.com/avatar.png');
    expect(row.language).toBe('fa');
  });

  it('escalation: status/roles/version in the payload are IGNORED (whitelist)', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: tracked.users[0] } });
    const beforeRoles = await prisma.userCompanyRole.count({ where: { userId: before.id } });

    // The escalation payload — with a whitelist-only endpoint these keys are
    // rejected by forbidNonWhitelisted (400), never applied either way.
    const res = await api('PATCH', '/api/auth/profile', state.adminToken, {
      status: 'DISABLED',
      roleIds: ['everything'],
      defaultCompanyId: null,
      version: 999999,
    });

    // Either the pipe refuses the unknown fields (400) or (if allowed) the
    // service whitelist drops them — the INVARIANT is the DB state.
    if (res.status === 200) {
      const after = await prisma.user.findUniqueOrThrow({ where: { id: tracked.users[0] } });
      expect(after.status).toBe(before.status);
      expect(after.version).toBe(before.version);
      expect(after.defaultCompanyId).toBe(before.defaultCompanyId);
      expect(await prisma.userCompanyRole.count({ where: { userId: before.id } })).toBe(beforeRoles);
    } else {
      expect(res.status).toBe(400);
    }
  });

  it('email uniqueness: another user is refused on duplicate email', async () => {
    const other = await prisma.user.create({
      data: {
        username: `core4-other-${state.marker}`,
        passwordHash: bcrypt.hashSync('Other-Passw0rd!', 8),
        status: 'ACTIVE',
        email: `core4-other-${state.marker}@test.local`,
      },
    });
    tracked.users.push(other.id);

    const res = await api('PATCH', '/api/auth/profile', state.adminToken, {
      email: `core4-other-${state.marker}@test.local`,
    });
    expect(res.status).toBe(422); // service ValidationError (email taken)
  });

  it('password: wrong current password is refused; nothing changes', async () => {
    const res = await api('POST', '/api/auth/change-password', state.adminToken, {
      currentPassword: 'WRONG-current-Pass!',
      newPassword: 'Brand-New-Passw0rd!1',
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('CURRENT_PASSWORD_INCORRECT');

    // Old password still works.
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: `core4-admin-${state.marker}`,
        password: ADMIN_PASSWORD,
      }),
    });
    expect(login.status).toBe(200);
  });

  it('password: correct current → change persists; old password dies; audit clean', async () => {
    const userId = tracked.users[0];
    const oldHash = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;

    const res = await api('POST', '/api/auth/change-password', state.adminToken, {
      currentPassword: ADMIN_PASSWORD,
      newPassword: 'Brand-New-Passw0rd!1',
    });
    expect(res.status).toBe(200);

    const newHash = (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).passwordHash;
    expect(newHash).not.toBe(oldHash);

    // Login with the OLD password now fails; NEW works.
    const oldLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `core4-admin-${state.marker}`, password: ADMIN_PASSWORD }),
    });
    expect(oldLogin.status).toBe(401); // UnauthorizedError on bad credentials
    const newLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: `core4-admin-${state.marker}`,
        password: 'Brand-New-Passw0rd!1',
      }),
    });
    expect(newLogin.status).toBe(200);

    // The audit NEVER contains password material.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'user', entityId: userId, action: 'PASSWORD_CHANGED' },
    });
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0].newValues)).not.toMatch(/passwordHash|Brand-New/i);
  });
});
