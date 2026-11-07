import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { FilesService } from '../files/files.service';
import { AuditService } from '../audit/audit.service';
import { CONFIG } from '../config/configuration';
import { loadConfig } from '../config/configuration';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';
import { randomBytes, createHmac } from 'crypto';

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

for (const [key, value] of Object.entries({
  JWT_SECRET: 'p3files-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'p3files-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const ADMIN_PASSWORD = 'P3-Admin-Passw0rd!';

/**
 * D-2 Phase 3 — portal FILES over REAL HTTP + REAL MinIO:
 *  - list shows ONLY attachments on the session party's own orders/loadings
 *  - download of a foreign party's / another company's attachment → 404 (IDOR)
 *  - unauthenticated → 401
 *  - own attachment downloads with the stored content
 */
describeIntegration('d2-phase3-files (real AppModule + MinIO)', () => {
  let prisma: PrismaService;
  let files: FilesService | null = null;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let A = '';
  let B = '';
  let adminToken = '';
  const marker = `p3-${Date.now()}`;
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  const portalAccountIds: string[] = [];
  const partyIds: string[] = [];
  const docIds: string[] = [];
  const attachmentIds: string[] = [];
  const visibleIds: Record<string, string> = {}; // companyId → visible attachment id
  const internalIds: Record<string, string> = {}; // companyId → internal attachment id
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;
  let minioUp = false;

  function hmac(data: string): string {
    return createHmac('sha256', process.env.JWT_SECRET ?? 'p3files-jwt-secret-0123456789').update(data).digest('hex');
  }

  async function makeSession(portalAccountId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await prisma.portalSession.create({
      data: { portalAccountId, tokenHash: hmac(raw), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return raw;
  }

  function portalGet(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { Cookie: `portal_session=${token}` } });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    const config = loadConfig();
    const audit = new AuditService(prisma as never);
    files = new FilesService(prisma as never, audit, config);

    for (const c of [`p3a-${marker}`, `p3b-${marker}`]) {
      const company = await prisma.company.create({ data: { nameFa: c, status: 'ACTIVE' } });
      if (A === '') A = company.id;
      else B = company.id;
      createdCompanies.push(company.id);
    }
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const admin = await prisma.user.create({
      data: { username: `p3-admin-${marker}`, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8), status: 'ACTIVE', mustChangePassword: false },
    });
    createdUsers.push(admin.id);
    for (const cid of [A, B]) {
      await prisma.userCompany.create({ data: { userId: admin.id, companyId: cid } });
      await prisma.userCompanyRole.create({ data: { userId: admin.id, companyId: cid, roleId: adminRole.id } });
      await prisma.sequence.create({
        data: { companyId: cid, documentType: 'SALES_DOCUMENT', name: 'SD', prefix: 'P3', padding: 5, resetCycle: 'NEVER' },
      });
    }

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
    // S3-backed tests need a REACHABLE MinIO; CI without one skips honestly.
    // Probe the CONFIGURED S3 endpoint (compose maps MinIO to :9100, CI :9000)
    const probed = new URL(loadConfig().S3_ENDPOINT);
    probed.hostname = '127.0.0.1';
    const s3Base = probed.toString().replace(/\/$/, '');
    minioUp = await fetch(`${s3Base}/minio/health/live`)
      .then((r) => r.ok)
      .catch(() => false);
    console.warn(`[p3] MinIO probe ${s3Base} → ${minioUp ? 'UP' : 'DOWN'}`);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: admin.username, password: ADMIN_PASSWORD }),
    });
    adminToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';

    // Parties + portal accounts: SAME mobile in A and B (selection flow).
    for (const [cid, label] of [[A, 'A'], [B, 'B']] as const) {
      const party = await prisma.party.create({
        data: { companyId: cid, type: 'COMPANY', nameFa: `p3-party-${label} ${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
      });
      partyIds.push(party.id);
      const pa = await prisma.portalAccount.create({
        data: { companyId: cid, partyId: party.id, verifiedMobile: '09120003001', status: 'ACTIVE' },
      });
      portalAccountIds.push(pa.id);
    }

    // One order per company owned by the party, one attachment uploaded per
    // order through the REAL FilesService (content-addressed MinIO write).
    for (const [cid, label, partyId] of [[A, 'A', partyIds[0]], [B, 'B', partyIds[1]]] as const) {
      const doc = await prisma.salesDocument.create({
        data: {
          companyId: cid, documentNumber: `P3-${label}-${marker}`,
          customerPartyId: partyId, documentDate: new Date(), status: 'COMPLETED', salespersonUserId: admin.id,
          createdBy: admin.id, version: 1, currency: 'IRR', total: 100,
        },
      });
      docIds.push(doc.id);
      // INTERNAL attachment (customerVisible NOT set → DEFAULT DENY)
      const { attachment } = await files!.upload(
        { buffer: Buffer.from(`p3-secret-${label}`), originalname: `p3-${label}.txt`, mimetype: 'text/plain', size: 12 },
        { entityType: 'sales_document', entityId: doc.id, displayName: `سند ${label}` },
        cid, { id: admin.id, username: admin.username }, {},
      );
      attachmentIds.push(attachment.id);
      internalIds[cid] = attachment.id;
      // CUSTOMER-VISIBLE attachment (explicitly flagged)
      const { attachment: visible } = await files!.upload(
        { buffer: Buffer.from(`p3-visible-${label}`), originalname: `p3-vis-${label}.txt`, mimetype: 'text/plain', size: 15 },
        { entityType: 'sales_document', entityId: doc.id, displayName: `صورت‌حساب ${label}`, customerVisible: true },
        cid, { id: admin.id, username: admin.username }, {},
      );
      attachmentIds.push(visible.id);
      visibleIds[cid] = visible.id;
    }
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
      await step('attachments', () => prisma.fileAttachment.deleteMany({ where: { id: { in: attachmentIds } } }));
      await step('blobs', () => prisma.fileBlob.deleteMany({ where: { createdAt: { gte: new Date(Date.now() - 3_600_000) } } }));
      await step('docs', () => prisma.salesDocument.deleteMany({ where: { id: { in: docIds } } }));
      await step('sessions', () => prisma.portalSession.deleteMany({ where: { portalAccountId: { in: portalAccountIds } } }));
      await step('accounts', () => prisma.portalAccount.deleteMany({ where: { id: { in: portalAccountIds } } }));
      await step('parties', () => prisma.party.deleteMany({ where: { id: { in: partyIds } } }));
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
      if (failures.length > 0) throw new Error(`P3 CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
  });

  itif('unauthenticated /api/portal/files → 401', async () => {
    const res = await portalGet('/api/portal/files', '');
    expect(res.status).toBe(401);
  });

  itif('company A session: list shows ONLY the customer-visible attachment (internal invisible)', async () => {
    if (!minioUp) {
      console.warn('[p3] skipped — MinIO unreachable (upload/list require the real storage)');
      return;
    }
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet('/api/portal/files', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; filename: string }>; total: number };
    expect(body.total).toBe(1); // DEFAULT DENY: only the visible one
    expect(body.items[0].filename).toContain('صورت‌حساب');
    // the INTERNAL attachment on the same order must NOT be listed
    expect(body.items.some((a) => a.id === internalIds[A])).toBe(false);
  });

  itif('D2-FINAL: INTERNAL attachment on the customer OWN order → NOT downloadable (DEFAULT DENY)', async () => {
    if (!minioUp) return;
    const token = await makeSession(portalAccountIds[0]);
    const dl = await portalGet(`/api/portal/files/${internalIds[A]}/download`, token);
    expect(dl.status).toBe(404);
  });

  itif('D2-FINAL: customer-VISIBLE attachment on the same order downloads', async () => {
    if (!minioUp) return;
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet(`/api/portal/files/${visibleIds[A]}/download`, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(`p3-visible-${'A'}`);
  });

  itif('IDOR: downloading the OTHER company attachment with the A session → 404', async () => {
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet(`/api/portal/files/${internalIds[B]}/download`, token);
    expect(res.status).toBe(404);
  });



  itif('company B session: A attachments not listed, own visible attachment downloadable', async () => {
    if (!minioUp) return;
    const tokenB = await makeSession(portalAccountIds[1]);
    const list = await portalGet('/api/portal/files', tokenB);
    const body = (await list.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(visibleIds[B]);
    expect(body.items[0].id).not.toBe(internalIds[B]);
    const dl = await portalGet(`/api/portal/files/${visibleIds[B]}/download`, tokenB);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('p3-visible-B');
  });
});
