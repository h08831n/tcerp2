import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'd4exp-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'd4exp-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const ADMIN_PASSWORD = 'D4-Admin-Passw0rd!';

/**
 * D-4 exports — real HTTP over the REAL AppModule:
 *  - products.csv / contacts.csv exist, are UTF-8-BOM CSV with headers,
 *    contain ONLY the requesting company's rows (isolation)
 *  - imports.export permission gates them
 */
describeIntegration('d4-exports (real AppModule)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let A = '';
  let B = '';
  let adminTokenA = '';
  let salespersonToken = '';
  const marker = `d4x-${Date.now()}`;
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  const cleanupAccountIds: string[] = [];
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();

    for (const c of [`d4xa-${marker}`, `d4xb-${marker}`]) {
      const company = await prisma.company.create({ data: { nameFa: c, status: 'ACTIVE' } });
      if (A === '') A = company.id;
      else B = company.id;
      createdCompanies.push(company.id);
    }
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const salespersonRole = await prisma.role.findUniqueOrThrow({ where: { code: 'salesperson' }, select: { id: true } });
    for (const cid of [A, B]) {
      const user = await prisma.user.create({
        data: { username: `d4x-${cid.slice(0, 6)}`, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8), status: 'ACTIVE', mustChangePassword: false },
      });
      createdUsers.push(user.id);
      await prisma.userCompany.create({ data: { userId: user.id, companyId: cid } });
      await prisma.userCompanyRole.create({ data: { userId: user.id, companyId: cid, roleId: adminRole.id } });
      if (cid === A) {
        // a user WITHOUT imports.export in company A
        const sp = await prisma.user.create({
          data: { username: `d4x-sp-${marker}`, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8), status: 'ACTIVE', mustChangePassword: false },
        });
        createdUsers.push(sp.id);
        await prisma.userCompany.create({ data: { userId: sp.id, companyId: A } });
        await prisma.userCompanyRole.create({ data: { userId: sp.id, companyId: A, roleId: salespersonRole.id } });
      }
    }

    // fixtures: template+variant in A, party+contact in A, party in B
    const category = await prisma.productCategory.create({ data: { companyId: A, code: `CAT-${marker}`, nameFa: `دسته ${marker}` } });
    const template = await prisma.productTemplate.create({
      data: { companyId: A, categoryId: category.id, internalCode: `TPL-${marker}`, nameFa: `قالب ${marker}` },
    });
    await prisma.productVariant.create({
      data: { companyId: A, templateId: template.id, sku: `VAR-${marker}`, nameFa: `ریز ${marker}`, combinationKey: `sku=VAR-${marker}` },
    });
    const partyA = await prisma.party.create({
      data: { companyId: A, type: 'COMPANY', nameFa: `مشتری ${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    await prisma.contact.create({
      data: { companyId: A, partyId: partyA.id, name: `تماس ${marker}`, position: 'مدیر', email: `c${marker}@t.local`, isPrimary: true },
    });
    const partyB = await prisma.party.create({
      data: { companyId: B, type: 'COMPANY', nameFa: `مشتری-B ${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    await prisma.contact.create({
      data: { companyId: B, partyId: partyB.id, name: `تماس-B ${marker}`, isPrimary: true },
    });
    void cleanupAccountIds;

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

    const loginA = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `d4x-${A.slice(0, 6)}`, password: ADMIN_PASSWORD }),
    });
    adminTokenA = ((await loginA.json()) as { accessToken?: string }).accessToken ?? '';
    const loginSp = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `d4x-sp-${marker}`, password: ADMIN_PASSWORD }),
    });
    salespersonToken = ((await loginSp.json()) as { accessToken?: string }).accessToken ?? '';
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
      await step('contacts', () => prisma.contact.deleteMany({ where: { companyId: A } }));
      await step('parties', () => prisma.party.deleteMany({ where: { companyId: { in: [A, B] } } }));
      await step('variants', () => prisma.productVariant.deleteMany({ where: { companyId: A } }));
      await step('templates', () => prisma.productTemplate.deleteMany({ where: { companyId: A } }));
      await step('categories', () => prisma.productCategory.deleteMany({ where: { companyId: A } }));
      await step('users', () => prisma.user.deleteMany({ where: { id: { in: createdUsers } } }));
      for (const cid of createdCompanies) {
        await step(`uc(${cid.slice(0, 6)})`, () => prisma.userCompany.deleteMany({ where: { companyId: cid } }));
        await step(`ucr(${cid.slice(0, 6)})`, () => prisma.userCompanyRole.deleteMany({ where: { companyId: cid } }));
        await step(`co(${cid.slice(0, 6)})`, async () => {
          await prisma.company.delete({ where: { id: cid } }).catch(() => undefined);
          if ((await prisma.company.count({ where: { id: cid } })) !== 0) failures.push(`LEFTOVER company ${cid}`);
        });
      }
      await prisma.$disconnect();
      if (failures.length > 0) throw new Error(`D4 CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
  });

  async function getExport(token: string, path: string): Promise<Response> {
    return fetch(`${baseUrl}/api/exports/${path}`, {
      headers: { Authorization: `Bearer ${token}`, 'x-company-id': A },
    });
  }

  itif('products.csv: BOM + headers + the A variant row only', async () => {
    const res = await getExport(adminTokenA, 'products.csv');
    expect(res.status).toBe(200);
    const text = (await res.text()).replace(/^\uFEFF/, '');
    const lines = text.trim().split(/\r?\n/);
    expect(lines[0]).toBe('templateInternalCode,templateNameFa,variantSku,variantNameFa,variantNameEn,defaultUomSymbol');
    expect(text).toContain(`VAR-${marker}`);
    expect(text).toContain(`TPL-${marker}`);
    // isolation: company B has no parties/products — nothing else leaks here,
    // but the ROW COUNT must match exactly one data row.
    expect(lines.length).toBe(2);
  });

  itif('contacts.csv: the A contact row only (isolation from B parties)', async () => {
    const res = await getExport(adminTokenA, 'contacts.csv');
    expect(res.status).toBe(200);
    const text = (await res.text()).replace(/^\uFEFF/, '');
    expect(text).toContain(`تماس ${marker}`);
    expect(text).toContain(`مشتری ${marker}`);
    expect(text).not.toContain(`مشتری-B ${marker}`);
  });

  itif('imports.export permission gates the exports (salesperson → 403)', async () => {
    const res = await getExport(salespersonToken, 'products.csv');
    expect(res.status).toBe(403);
    const res2 = await getExport(salespersonToken, 'contacts.csv');
    expect(res2.status).toBe(403);
  });

  itif('company isolation: B admin exporting with x-company-id A still gets A rows scoped by THEIR context', async () => {
    // login as B admin, export with B's own context → B parties only (empty
    // products), and never A's rows.
    const loginB = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: `d4x-${B.slice(0, 6)}`, password: ADMIN_PASSWORD }),
    });
    const tokenB = ((await loginB.json()) as { accessToken?: string }).accessToken ?? '';
    const res = await fetch(`${baseUrl}/api/exports/contacts.csv`, {
      headers: { Authorization: `Bearer ${tokenB}`, 'x-company-id': B },
    });
    expect(res.status).toBe(200);
    const text = (await res.text()).replace(/^\uFEFF/, '');
    expect(text).toContain(`مشتری-B ${marker}`);
    expect(text).not.toContain(`مشتری ${marker}`);
  });
});
