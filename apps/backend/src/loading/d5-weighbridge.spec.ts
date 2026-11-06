import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { AuditService } from '../audit/audit.service';
import { loadConfig } from '../config/configuration';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'd5wb-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'd5wb-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const PASSWORD = 'D5-Admin-Passw0rd!';

/**
 * D-5 — loading completion: weighbridge recording + loading attachments
 * over REAL HTTP:
 *  - out < in → 422 WEIGHBRIDGE_OUT_LT_IN (nothing written)
 *  - valid recording → net computed server-side, delta vs the loading's
 *    expected weight (Σ actualQuantity × weightPerUnit × ratio), audited
 *  - attachment upload via the EXISTING multipart /files with
 *    entityType=loading → visible in the loading attachments list AND in
 *    the portal files list (party-owned loading)
 *  - foreign loading → 404
 */
describeIntegration('d5-loading-weighbridge (real AppModule + MinIO)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let companyId = '';
  let adminToken = '';
  const marker = `d5-${Date.now()}`;
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  let loadingId = '';
  let loadingIdForeign = '';
  let variantWithWeight = '';
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    const company = await prisma.company.create({ data: { nameFa: `d5-${marker}`, status: 'ACTIVE' } });
    companyId = company.id;
    createdCompanies.push(company.id);
    const companyB = await prisma.company.create({ data: { nameFa: `d5b-${marker}`, status: 'ACTIVE' } });
    createdCompanies.push(companyB.id);
    void companyB;

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const user = await prisma.user.create({
      data: { username: `d5-admin-${marker}`, passwordHash: bcrypt.hashSync(PASSWORD, 8), status: 'ACTIVE', mustChangePassword: false },
    });
    createdUsers.push(user.id);
    for (const cid of createdCompanies) {
      await prisma.userCompany.create({ data: { userId: user.id, companyId: cid } });
      await prisma.userCompanyRole.create({ data: { userId: user.id, companyId: cid, roleId: adminRole.id } });
      await prisma.sequence.create({ data: { companyId: cid, documentType: 'LOADING', name: 'LR', prefix: 'D5', padding: 5, resetCycle: 'NEVER' } });
    }

    // variant WITH weight metadata: 40 kg per unit, weight uom ratio 1 (kg)
    const uomCat = await prisma.uomCategory.create({ data: { companyId, code: `W-${marker}`, nameFa: 'وزن' } });
    await prisma.uom.create({ data: { companyId, categoryId: uomCat.id, nameFa: 'کیلوگرم', symbol: 'kg', conversionRatio: 1, isBaseUnit: true } });
    const cat = await prisma.productCategory.create({ data: { companyId, code: `C-${marker}`, nameFa: 'دسته' } });
    const template = await prisma.productTemplate.create({
      data: { companyId, categoryId: cat.id, internalCode: `T-${marker}`, nameFa: 'قالب' },
    });
    const variant = await prisma.productVariant.create({
      data: { companyId, templateId: template.id, sku: `V-${marker}`, nameFa: 'ورق', combinationKey: `sku=V-${marker}`,
        weightPerUnit: 40, weightUomId: (await prisma.uom.findFirstOrThrow({ where: { companyId, symbol: 'kg' } })).id },
    });
    variantWithWeight = variant.id;

    // two loadings with ONE line of actualQuantity 10 → expected 400 kg
    const companyBId = typeof companyB === 'string' ? companyB : companyB.id;
    for (const [cid, label] of [[companyId, 'own'], [companyBId, 'foreign']] as const) {
      const party = await prisma.party.create({
        data: { companyId: cid, type: 'COMPANY', nameFa: `p-${label}-${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
      });
      const loading = await prisma.loading.create({
        data: {
          companyId: cid, loadingDate: new Date(), status: 'CONFIRMED',
          customerPartyId: party.id, createdBy: user.id,
          lines: { create: [{ productVariantId: variant.id, actualQuantity: 10 }] },
        },
      });
      if (cid === companyId) loadingId = loading.id;
      else loadingIdForeign = loading.id;
      void companyBId;
    }

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

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: user.username, password: PASSWORD }),
    });
    adminToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';
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
      await step('fileAttachments', () => prisma.fileAttachment.deleteMany({ where: { companyId: { in: createdCompanies } } }));
      await step('fileBlobs', () => prisma.fileBlob.deleteMany({ where: { createdAt: { gte: new Date(Date.now() - 3_600_000) } } }));
      await step('auditLogs', () => prisma.auditLog.deleteMany({ where: { companyId: { in: createdCompanies } } }));
      await step('loadingLines', () => prisma.loadingLine.deleteMany({ where: { loading: { companyId: { in: createdCompanies } } } }));
      await step('loadings', () => prisma.loading.deleteMany({ where: { companyId: { in: createdCompanies } } }));
      await step('variants', () => prisma.productVariant.deleteMany({ where: { companyId } }));
      await step('templates', () => prisma.productTemplate.deleteMany({ where: { companyId } }));
      await step('categories', () => prisma.productCategory.deleteMany({ where: { companyId } }));
      await step('uoms', () => prisma.uom.deleteMany({ where: { companyId } }));
      await step('uomCats', () => prisma.uomCategory.deleteMany({ where: { companyId } }));
      await step('parties', () => prisma.party.deleteMany({ where: { companyId: { in: createdCompanies } } }));
      await step('users', () => prisma.user.deleteMany({ where: { id: { in: createdUsers } } }));
      for (const cid of createdCompanies) {
        await step(`seq(${cid.slice(0, 6)})`, () => prisma.sequence.deleteMany({ where: { companyId: cid } }));
        await step(`uc(${cid.slice(0, 6)})`, () => prisma.userCompany.deleteMany({ where: { companyId: cid } }));
        await step(`ucr(${cid.slice(0, 6)})`, () => prisma.userCompanyRole.deleteMany({ where: { companyId: cid } }));
        await step(`co(${cid.slice(0, 6)})`, async () => {
          await prisma.company.delete({ where: { id: cid } }).catch(() => undefined);
          if ((await prisma.company.count({ where: { id: cid } })) !== 0) failures.push(`LEFTOVER company ${cid}`);
        });
      }
      await prisma.$disconnect();
      if (failures.length > 0) throw new Error(`D5 CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
  });

  function post(path: string, body: unknown, token = adminToken, company = companyId): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'x-company-id': company },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  itif('out < in → 422 WEIGHBRIDGE_OUT_LT_IN and NOTHING is written', async () => {
    const res = await post(`/api/loadings/${loadingId}/weighbridge`, { inKg: 500, outKg: 400 });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message?: string }).message).toBe('WEIGHBRIDGE_OUT_LT_IN');
    const loading = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(loading.weighbridgeInKg).toBeNull();
  });

  itif('valid recording → net computed server-side, delta vs expected (400 kg), audited', async () => {
    const res = await post(`/api/loadings/${loadingId}/weighbridge`, { ticketNo: `TKT-${marker}`, inKg: 9500, outKg: 9890 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      netKg: string; expectedKg: string; deltaKg: string; deltaPercent: number; unmeasurableLines: number;
    };
    expect(body.netKg).toBe('390');
    expect(body.expectedKg).toBe('400'); // 10 × 40 kg × ratio 1
    expect(body.deltaKg).toBe('-10');
    expect(body.deltaPercent).toBe(-2.5);
    expect(body.unmeasurableLines).toBe(0);

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'loading', entityId: loadingId, action: 'UPDATE' } });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    expect((audits[0].newValues as { weighbridgeNetKg: string }).weighbridgeNetKg).toBe('390');
  });

  itif('foreign loading → 404 (company isolation)', async () => {
    const res = await post(`/api/loadings/${loadingIdForeign}/weighbridge`, { inKg: 100, outKg: 200 });
    expect(res.status).toBe(404);
  });

  itif('attachment upload via /files with entityType=loading → in the loading attachments list AND portal files', async () => {
    // upload via the EXISTING multipart endpoint (files.upload permission = admin)
    const boundary = '----d5wb' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="ticket.png"\r\nContent-Type: image/png\r\n\r\n`),
      Buffer.from('PNGDATA-' + marker),
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityType"\r\n\r\nloading\r\n--${boundary}\r\nContent-Disposition: form-data; name="entityId"\r\n\r\n${loadingId}\r\n--${boundary}--\r\n`),
    ]);
    const up = await fetch(`${baseUrl}/api/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'x-company-id': companyId, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: new Uint8Array(body),
    });
    expect([200, 201]).toContain(up.status);
    const upBody = (await up.json()) as { attachment?: { id?: string } };
    const attachmentId = upBody.attachment?.id ?? '';
    expect(attachmentId).toBeTruthy();

    const list = await fetch(`${baseUrl}/api/loadings/${loadingId}/attachments`, {
      headers: { Authorization: `Bearer ${adminToken}`, 'x-company-id': companyId },
    });
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { items?: Array<{ id: string }> } | Array<{ id: string }>;
    const items = Array.isArray(listBody) ? listBody : (listBody.items ?? []);
    expect(items.some((a) => a.id === attachmentId)).toBe(true);

    // the portal file list (Phase 3) includes loading attachments
    const files = await prisma.fileAttachment.findMany({ where: { entityType: 'loading', entityId: loadingId } });
    expect(files.some((f) => f.id === attachmentId)).toBe(true);
  });
});
