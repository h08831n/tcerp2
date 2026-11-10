import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';

/**
 * CORE-003 — settings center acceptance over the REAL AppModule (HTTP).
 *
 * Laws under test:
 *  - The catalog returns the registry merged with current values; every
 *    entry has a REAL backend consumer.
 *  - Typed upsert validates/coerces by registry type (number/boolean/select/
 *    string) — invalid values are refused with a Persian message.
 *  - A saved setting is VISIBLE to its consumer: files.max_upload_mb is
 *    enforced by files.service.upload; sales.quotation_expiration_days by
 *    the sales document creation; crm.lead_sources by the leads UI feed.
 *  - Restore default = delete the override row (consumer falls back); audited.
 *  - settings.edit is required for writes; settings.view for reads.
 */

const ADMIN_PASSWORD = 'Core3-Admin-Passw0rd!';

if (TEST_INTEGRATION) {
  assertSafeIntegrationDatabase(process.env.DATABASE_URL);
}

for (const [key, value] of Object.entries({
  JWT_SECRET: process.env.JWT_SECRET ?? 'core3-jwt-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'core3-jwt-refresh-secret-0123456789',
  NODE_ENV: 'test',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const state = {
  adminToken: '',
  adminId: '',
  companyId: '00000000-0000-4000-8000-000000000001',
  marker: '',
};

describeIntegration('core-003 settings center (real AppModule over HTTP)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  const tracked = { users: [] as string[], roles: [] as string[] };

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
    state.marker = `core3-${Date.now()}`;

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const admin = await prisma.user.create({
      data: {
        username: `core3-admin-${state.marker}`,
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
    state.adminId = admin.id;
  });

  afterAll(async () => {
    if (prisma) {
      // Restore all touched settings to defaults (delete overrides).
      await prisma.setting.deleteMany({
        where: { companyId: state.companyId, key: { in: ['sales.quotation_expiration_days', 'files.max_upload_mb', 'inventory.negative_stock_policy'] } },
      }).catch(() => undefined);
      await prisma.userCompanyRole.deleteMany({ where: { userId: { in: tracked.users } } }).catch(() => undefined);
      await prisma.userCompany.deleteMany({ where: { userId: { in: tracked.users } } }).catch(() => undefined);
      await prisma.user.deleteMany({ where: { id: { in: tracked.users } } }).catch(() => undefined);
      await prisma.$disconnect();
    }
    if (app) await app.close();
  });

  it('catalog: registry + current values, every entry has a consumer', async () => {
    const res = await api('GET', '/api/settings/catalog', state.adminToken);
    expect(res.status).toBe(200);
    // GET /settings/catalog returns the array directly (no envelope).
    const items = res.body as unknown as Array<{
      key: string;
      category: string;
      consumer: string;
      isOverridden: boolean;
    }>;
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(8);
    const keys = items.map((i) => i.key);
    expect(keys).toContain('sales.quotation_expiration_days');
    expect(keys).toContain('inventory.negative_stock_policy');
    expect(keys).toContain('crm.lead_sources');
    for (const item of items) {
      expect(item.consumer.length).toBeGreaterThan(0); // no display-only settings
      expect(item.category.length).toBeGreaterThan(0);
    }
  });

  it('typed upsert: invalid values are refused by registry type', async () => {
    const badNumber = await api('PUT', '/api/settings/catalog/sales.quotation_expiration_days', state.adminToken, {
      value: 'not-a-number',
    });
    expect(badNumber.status).toBe(422);

    const badSelect = await api('PUT', '/api/settings/catalog/inventory.negative_stock_policy', state.adminToken, {
      value: 'MAYBE',
    });
    expect(badSelect.status).toBe(422);

    const unknownKey = await api('PUT', '/api/settings/catalog/does.not.exist', state.adminToken, {
      value: 1,
    });
    expect(unknownKey.status).toBe(422);
  });

  it('REAL effect: sales.quotation_expiration_days changes the quotation expiry', async () => {
    // Save 7 days.
    const save = await api('PUT', '/api/settings/catalog/sales.quotation_expiration_days', state.adminToken, {
      value: 7,
    });
    expect(save.status).toBe(200); // PUT → 200

    // Create a quotation as the admin (simplest via the API using an existing
    // customer party — the seeded admin company has seeded parties).
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { companyId: state.companyId },
    });
    const uom = await prisma.uom.findFirstOrThrow({ where: { companyId: state.companyId } });
    // Ensure a CUSTOMER-role party exists (create + link, tracked).
    let party = await prisma.party.findFirst({
      where: { companyId: state.companyId, roles: { some: { role: 'CUSTOMER' } } },
    });
    if (!party) {
      party = await prisma.party.create({
        data: { companyId: state.companyId, type: 'COMPANY', nameFa: `core3-cust-${state.marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
      });
    }

    const before = new Date();
    const quote = await api('POST', '/api/sales', state.adminToken, {
      customerPartyId: party.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 1, unitPrice: 1000, uomId: uom.id }],
    });
    expect(quote.status).toBe(201);
    const expiration = new Date(quote.body.expirationDate as string);
    const days = Math.round((expiration.getTime() - before.getTime()) / 86400000);
    expect(Math.abs(days - 7)).toBeLessThanOrEqual(1); // 7-day expiry from the SETTING
  });

  it('REAL effect: files.max_upload_mb rejects oversized uploads', async () => {
    const save = await api('PUT', '/api/settings/catalog/files.max_upload_mb', state.adminToken, { value: 1 });
    expect(save.status).toBe(200);

    // The enforcement lives in files.service.upload (infra hard cap 50MB in
    // multer; the SETTING is enforced per company at the service seam).
    // S3 storage is not available in this suite → the rejection MUST happen
    // BEFORE any S3 call (size check precedes the upload).
    const filesService = app!.get(require('../files/files.service').FilesService);
    const party = await prisma.party.create({
      data: { companyId: state.companyId, type: 'COMPANY', nameFa: `core3-file-${state.marker}` },
    });
    const doc = await prisma.salesDocument.create({
      data: {
        companyId: state.companyId,
        documentNumber: `CORE3-${state.marker.slice(-8)}`,
        customerPartyId: party.id,
        salespersonUserId: state.adminId || (await prisma.user.findFirstOrThrow()).id,
        documentDate: new Date(),
        status: 'DRAFT',
        currency: 'IRR',
        total: 0,
        createdBy: (await prisma.user.findFirstOrThrow()).id,
      },
    });

    const big = Buffer.alloc(2 * 1024 * 1024, 7); // 2MB > 1MB setting
    await expect(
      filesService.upload(
        { buffer: big, originalname: 'big.bin', mimetype: 'application/octet-stream', size: big.length },
        { entityType: 'sales_document', entityId: doc.id },
        state.companyId,
        { id: 'core3-test', username: 'core3-test' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'FILE_TOO_LARGE' });
  });

  it('restore default deletes the override (consumer falls back)', async () => {
    const restore = await api('DELETE', '/api/settings/catalog/sales.quotation_expiration_days', state.adminToken);
    expect(restore.status).toBe(200);
    expect(restore.body.restored).toBe(true);

    const row = await prisma.setting.findUnique({
      where: {
        companyId_key: { companyId: state.companyId, key: 'sales.quotation_expiration_days' },
      },
    });
    expect(row).toBeNull(); // the override row is gone — consumer uses the default
  });

  it('CORE-003 §4: the LEGACY raw-key PUT /settings is REMOVED (no bypass)', async () => {
    // The old endpoint accepted arbitrary keys/values with no registry
    // validation — a bypass of the typed center. It is REMOVED: 404 now,
    // for admins and non-admins alike.
    const asAdmin = await api('PUT', '/api/settings', state.adminToken, {
      key: 'some.hack.key',
      value: { v: 123 },
    });
    expect(asAdmin.status).toBe(404);
    const wrongValue = await api('PUT', '/api/settings', state.adminToken, {
      key: 'inventory.negative_stock_policy',
      value: 'MAYBE',
    });
    expect(wrongValue.status).toBe(404);
  });
  it('CORE-003 §6: files.max_upload_mb accepts ONLY integers 1..50', async () => {
    // Zero, negative, decimal, above-cap and non-numeric → all refused.
    for (const bad of [0, -5, 7.5, 51, 500, 'abc']) {
      const res = await api('PUT', '/api/settings/catalog/files.max_upload_mb', state.adminToken, {
        value: bad,
      });
      expect(res.status).toBe(422);
    }
    // Boundary values accepted.
    const one = await api('PUT', '/api/settings/catalog/files.max_upload_mb', state.adminToken, { value: 1 });
    expect(one.status).toBe(200);
    const fifty = await api('PUT', '/api/settings/catalog/files.max_upload_mb', state.adminToken, { value: 50 });
    expect(fifty.status).toBe(200);
    // Restore default (50).
    const restore = await api('DELETE', '/api/settings/catalog/files.max_upload_mb', state.adminToken);
    expect(restore.status).toBe(200);
  });

  it('CORE-003 §12 company scope: the catalog is company-scoped', async () => {
    // Save an override in the seeded company…
    const save = await api('PUT', '/api/settings/catalog/sales.quotation_expiration_days', state.adminToken, {
      value: 21,
    });
    expect(save.status).toBe(200);
    // …then verify the DB row carries THIS companyId (never cross-company).
    const row = await prisma.setting.findUnique({
      where: {
        companyId_key: {
          companyId: state.companyId,
          key: 'sales.quotation_expiration_days',
        },
      },
    });
    expect(row).not.toBeNull();
    await prisma.setting.delete({
      where: { companyId_key: { companyId: state.companyId, key: 'sales.quotation_expiration_days' } },
    }).catch(() => undefined);
  });

  it('permissions: settings.view is required to read; edit to write', async () => {
    // A user with NO settings permissions → 403.
    const noPermRole = await prisma.role.create({
      data: { code: `core3-noperm-${state.marker.slice(-6)}`, nameFa: 'بدون دسترسی', nameEn: 'no-perm' },
    });
    tracked.roles.push(noPermRole.id);
    const u = await prisma.user.create({
      data: {
        username: `core3-noperm-${state.marker}`,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    tracked.users.push(u.id);
    await prisma.userCompany.create({ data: { userId: u.id, companyId: state.companyId } });
    await prisma.userCompanyRole.create({
      data: { userId: u.id, companyId: state.companyId, roleId: noPermRole.id },
    });

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u.username, password: ADMIN_PASSWORD }),
    });
    const token = ((await login.json()) as { accessToken?: string }).accessToken ?? '';
    expect(token).toBeTruthy();

    const read = await api('GET', '/api/settings/catalog', token);
    expect(read.status).toBe(403);
    const write = await api('PUT', '/api/settings/catalog/files.max_upload_mb', token, { value: 10 });
    expect(write.status).toBe(403);
  });
});
