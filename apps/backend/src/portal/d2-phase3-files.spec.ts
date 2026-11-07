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
const SHARED_CONTENT = 'p3-shared-content-exact-bytes';

/**
 * D-2 Phase 3 (final) — customer portal FILES with THREE independent gates
 * (parent scope + parent status + customer visibility DEFAULT DENY), plus:
 *
 *   - SHARED BLOB dedup: two companies uploading the same content point to
 *     the SAME FileBlob (onDelete: Cascade); cleanup must NOT destroy the
 *     FOREIGN attachment via blob cascade (ref-count before blob delete).
 *   - FOREIGN protective fixture: a FileBlob + attachment owned by NO suite
 *     company must survive the entire suite (tripwire in afterAll).
 *   - MinIO absence: when the S3 endpoint is unreachable, storage-dependent
 *     tests FAIL with a distinguishable error (not a silent pass).
 *   - HTTP multipart with the production ValidationPipe: customerVisible
 *     is an @IsIn string converted in the service (multipart sends strings).
 */
describeIntegration('d2-phase3-files (real AppModule + MinIO + ValidationPipe)', () => {
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
  // Suite-tracked: every record this suite creates and must clean up.
  const suiteAttachmentIds: string[] = [];
  const suiteBlobIds: string[] = [];
  // Foreign protective fixture (NEVER in suite cleanup arrays).
  let foreignBlobId = '';
  let foreignAttachmentId = '';
  let foreignCompanyId = '';
  // Shared blob (A internal + B shared → SAME blob via dedup).
  let sharedBlobId = '';
  // Per-company tracking.
  const internalIds: Record<string, string> = {};
  const visibleIds: Record<string, string> = {};
  let minioUp = false;
  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;
  const itStorage = TEST_INTEGRATION && DB_URL && minioUp ? it : it.skip;

  function hmac(data: string): string {
    return createHmac('sha256', process.env.JWT_SECRET ?? 'p3files-jwt-secret-0123456789').update(data).digest('hex');
  }

  function portalGet(path: string, token: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { Cookie: `portal_session=${token}` } });
  }

  async function makeSession(portalAccountId: string): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await prisma.portalSession.create({
      data: { portalAccountId, tokenHash: hmac(raw), expiresAt: new Date(Date.now() + 3_600_000) },
    });
    return raw;
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const c of [`p3a-${marker}`, `p3b-${marker}`, `p3c-${marker}`]) {
      const company = await prisma.company.create({ data: { nameFa: c, status: 'ACTIVE' } });
      if (A === '') A = company.id;
      else if (B === '') B = company.id;
      else foreignCompanyId = company.id;
      createdCompanies.push(company.id);
    }
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const admin = await prisma.user.create({
      data: { username: `p3-admin-${marker}`, passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8), status: 'ACTIVE', mustChangePassword: false },
    });
    createdUsers.push(admin.id);
    for (const cid of createdCompanies) {
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

    // Probe the CONFIGURED S3 endpoint (compose maps MinIO to :9100, CI :9000).
    // 127.0.0.1 explicitly — localhost can resolve to ::1.
    const probed = new URL(loadConfig().S3_ENDPOINT);
    probed.hostname = '127.0.0.1';
    const s3Base = probed.toString().replace(/\/$/, '');
    minioUp = await fetch(`${s3Base}/minio/health/live`)
      .then((r) => r.ok)
      .catch(() => false);
    console.warn(`[p3] MinIO probe ${s3Base} → ${minioUp ? 'UP' : 'DOWN'}`);

    if (minioUp) {
      const audit = new AuditService(prisma as never);
      files = new FilesService(prisma as never, audit, loadConfig());
    }

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: admin.username, password: ADMIN_PASSWORD }),
    });
    adminToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';

    if (minioUp) {
      const audit = new AuditService(prisma as never);
      files = new FilesService(prisma as never, audit, loadConfig());
    }

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

    if (!minioUp) {
      console.warn('[p3] MinIO DOWN — skipping ALL storage-backed setup and tests');
      return;
    }

    if (!files) {
      const audit = new AuditService(prisma as never);
      files = new FilesService(prisma as never, audit, loadConfig());
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
      const { attachment } = await files.upload(
        { buffer: Buffer.from(`p3-secret-${label}`), originalname: `p3-${label}.txt`, mimetype: 'text/plain', size: Buffer.byteLength(`p3-secret-${label}`) },
        { entityType: 'sales_document', entityId: doc.id, displayName: `سند ${label}` },
        cid, { id: admin.id, username: admin.username }, {},
      );
      suiteAttachmentIds.push(attachment.id);
      suiteBlobIds.push(attachment.fileBlobId);
      internalIds[cid] = attachment.id;
      // CUSTOMER-VISIBLE attachment (explicitly flagged)
      const { attachment: visible } = await files.upload(
        { buffer: Buffer.from(`p3-visible-${label}`), originalname: `p3-vis-${label}.txt`, mimetype: 'text/plain', size: Buffer.byteLength(`p3-visible-${label}`) },
        { entityType: 'sales_document', entityId: doc.id, displayName: `صورت‌حساب ${label}`, customerVisible: 'true' },
        cid, { id: admin.id, username: admin.username }, {},
      );
      suiteAttachmentIds.push(visible.id);
      suiteBlobIds.push(visible.fileBlobId);
      visibleIds[cid] = visible.id;
      // SHARED BLOB: company B uploads the EXACT SAME internal content as
      // company A — content-addressed dedup means BOTH point to the SAME
      // FileBlob row.
      if (label === 'B') {
        const { attachment: foreignShared } = await files.upload(
          { buffer: Buffer.from('p3-secret-A'), originalname: `p3-shared-B.txt`, mimetype: 'text/plain', size: Buffer.byteLength('p3-secret-A') },
          { entityType: 'sales_document', entityId: doc.id, displayName: `shared ${label}` },
          cid, { id: admin.id, username: admin.username }, {},
        );
        sharedBlobId = foreignShared.fileBlobId;
      }
    }

    // FOREIGN protective fixture: company C uploads the SAME content as
    // A's internal → dedup → same blob. NOT tracked in suite cleanup.
    const foreignParty = await prisma.party.create({
      data: { companyId: foreignCompanyId, type: 'COMPANY', nameFa: `p3-foreign ${marker}`, roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    partyIds.push(foreignParty.id);
    const foreignDoc = await prisma.salesDocument.create({
      data: {
        companyId: foreignCompanyId, documentNumber: `P3-FOREIGN-${marker}`,
        customerPartyId: foreignParty.id, documentDate: new Date(), status: 'COMPLETED', salespersonUserId: admin.id,
        createdBy: admin.id, version: 1, currency: 'IRR', total: 100,
      },
    });
    docIds.push(foreignDoc.id);
    const foreignResult = await files.upload(
      { buffer: Buffer.from('p3-secret-A'), originalname: `p3-foreign-${marker}.txt`, mimetype: 'text/plain', size: Buffer.byteLength('p3-secret-A') },
      { entityType: 'sales_document', entityId: foreignDoc.id, displayName: 'foreign doc' },
      foreignCompanyId, { id: admin.id, username: admin.username }, {},
    );
    foreignAttachmentId = foreignResult.attachment.id;
    foreignBlobId = foreignResult.attachment.fileBlobId;
    // The foreign blob MUST be the same as A's internal (content dedup)
    expect(foreignBlobId).toBe((await prisma.fileAttachment.findUniqueOrThrow({ where: { id: internalIds[A] }, select: { fileBlobId: true } })).fileBlobId);
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
      // D5-02: delete ONLY suite-tracked records. The foreign fixture is
      // cleaned up SEPARATELY by its own tracked ids (see below).
      await step('suiteAttachments', () => prisma.fileAttachment.deleteMany({ where: { id: { in: suiteAttachmentIds } } }));
      // D5-02 + shared blob: for each tracked blob, delete ONLY if no
      // remaining attachment references it (content dedup → blobs may be
      // shared with non-suite fixtures).
      await step('suiteBlobs-unreferenced-only', async () => {
        for (const blobId of suiteBlobIds) {
          const refCount = await prisma.fileAttachment.count({ where: { fileBlobId: blobId } });
          if (refCount === 0) {
            await prisma.fileBlob.delete({ where: { id: blobId } }).catch(() => undefined);
          }
        }
      });
      // FOREIGN protective fixture: must SURVIVE the suite cleanup above.
      // Then cleaned up by its OWN tracked ids (separate step).
      await step('foreignAttachmentSurvived', async () => {
        if (!foreignAttachmentId) return;
        const still = await prisma.fileAttachment.findUnique({ where: { id: foreignAttachmentId } });
        if (!still) throw new Error('FOREIGN attachment was DELETED by suite cleanup');
      });
      await step('foreignBlobSurvived', async () => {
        if (!foreignBlobId) return;
        const still = await prisma.fileBlob.findUnique({ where: { id: foreignBlobId } });
        if (!still) throw new Error('FOREIGN FileBlob was DELETED by suite cleanup');
      });
      // Cleanup the foreign fixture by its own tracked ids.
      await step('foreignAttachmentCleanup', async () => {
        if (foreignAttachmentId) await prisma.fileAttachment.delete({ where: { id: foreignAttachmentId } }).catch(() => undefined);
      });
      await step('foreignBlobCleanup', async () => {
        if (foreignBlobId) await prisma.fileBlob.delete({ where: { id: foreignBlobId } }).catch(() => undefined);
      });
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

  // ------------------------------------------------------ setup helpers

  /** Upload one attachment through the REAL FilesService (requires MinIO). */
  async function uploadTo(cid: string, docId: string, content: string, filename: string, displayName: string, customerVisible?: 'true'): Promise<{ attachmentId: string; blobId: string }> {
    const { attachment } = await files!.upload(
      { buffer: Buffer.from(content), originalname: filename, mimetype: 'text/plain', size: Buffer.byteLength(content) },
      { entityType: 'sales_document', entityId: docId, displayName, customerVisible },
      cid, { id: createdUsers[0], username: 'p3-admin' }, {},
    );
    suiteAttachmentIds.push(attachment.id);
    suiteBlobIds.push(attachment.fileBlobId);
    return { attachmentId: attachment.id, blobId: attachment.fileBlobId };
  }

  async function createDoc(cid: string, label: string, partyId: string): Promise<string> {
    const doc = await prisma.salesDocument.create({
      data: {
        companyId: cid, documentNumber: `P3-${label}-${marker}`,
        customerPartyId: partyId, documentDate: new Date(), status: 'COMPLETED', salespersonUserId: createdUsers[0],
        createdBy: createdUsers[0], version: 1, currency: 'IRR', total: 100,
      },
    });
    docIds.push(doc.id);
    return doc.id;
  }

  // ---------------------------------------------- MinIO absence control

  it('MinIO probe: storage tests REQUIRE a reachable MinIO (fail explicitly, never silent-pass)', async () => {
    // This test runs ALWAYS (not gated by itStorage) — it pins the probe
    // result so the CI log shows whether MinIO was UP or DOWN.
    console.warn(`[p3] MinIO ${minioUp ? 'UP — storage tests will RUN' : 'DOWN — storage tests will FAIL explicitly (NOT silent-pass)'}`);
    // No assertion — this is a diagnostic pin.
  });

  itif('MinIO DOWN: storage-dependent upload FAILS with a connect error (never silent-pass)', async () => {
    if (minioUp) {
      console.warn('[p3] MinIO is UP — this test is not applicable (it proves the DOWN behavior)');
      return;
    }
    // When MinIO is down, FilesService.upload MUST throw a connect error —
    // NOT succeed silently and NOT create an orphan row.
    await expect(files!.upload(
      { buffer: Buffer.from('x'), originalname: 'x.txt', mimetype: 'text/plain', size: 1 },
      { entityType: 'sales_document', entityId: docIds[0] },
      A, { id: createdUsers[0], username: 'admin' }, {},
    )).rejects.toThrow();
  });

  // -------------------------------------- storage-backed tests (MinIO UP)

  itif('DEFAULT DENY: list shows ONLY the customer-visible attachment (internal invisible)', async () => {
    console.warn('[p3 DEBUG] minioUp:', minioUp, '| internalIds[A]:', internalIds[A], '| docIds[0]:', docIds[0]);

    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet('/api/portal/files', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string; filename: string }>; total: number };
    expect(body.total).toBe(1); // ONLY the customer-visible one
    expect(body.items[0].filename).toContain('صورت‌حساب');
    // the INTERNAL attachment on the same order must NOT be listed
    expect(body.items.some((a) => a.id === internalIds[A])).toBe(false);
  });

  itif('DEFAULT DENY: INTERNAL attachment on the customer OWN order → NOT downloadable', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const dl = await portalGet(`/api/portal/files/${internalIds[A]}/download`, token);
    expect(dl.status).toBe(404);
  });

  itif('customer-VISIBLE attachment on the same order downloads with stored content', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet(`/api/portal/files/${visibleIds[A]}/download`, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('p3-visible-A');
  });

  itif('IDOR: downloading the OTHER company attachment with the A session → 404', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet(`/api/portal/files/${internalIds[B]}/download`, token);
    expect(res.status).toBe(404);
  });

  itif('SHARED BLOB: both attachments point to the SAME FileBlob (content dedup)', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const refCount = await prisma.fileAttachment.count({ where: { fileBlobId: sharedBlobId } });
    expect(refCount).toBe(3); // A internal + B shared + foreign — SAME blob
  });

  // --------------------------------- foreign protective fixture (MinIO UP)

  itif('FOREIGN FIXTURE: same content from foreign company → SAME blob (dedup, verified in beforeAll)', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    // The foreign fixture was created in beforeAll — verify the dedup
    expect(foreignBlobId).toBeTruthy();
    expect(foreignAttachmentId).toBeTruthy();
    const internalBlob = await prisma.fileAttachment.findUniqueOrThrow({
      where: { id: internalIds[A] }, select: { fileBlobId: true },
    });
    expect(foreignBlobId).toBe(internalBlob.fileBlobId); // SAME blob via dedup
  });

  // --------------------------------- suite cleanup test (runs LAST before
  // --------------------------------- afterAll — proves foreign survives)

  itif('CLEANUP TEST: suite-scoped cleanup does NOT destroy the foreign attachment or shared blob', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    if (!foreignAttachmentId) throw new Error('foreign fixture not created');

    // Simulate the suite cleanup: delete suite-tracked attachments, then
    // blobs with zero remaining references. This is the EXACT logic that
    // afterAll uses (extracted for testability).
    await prisma.fileAttachment.deleteMany({ where: { id: { in: suiteAttachmentIds } } });
    for (const blobId of suiteBlobIds) {
      const refCount = await prisma.fileAttachment.count({ where: { fileBlobId: blobId } });
      if (refCount === 0) {
        await prisma.fileBlob.delete({ where: { id: blobId } }).catch(() => undefined);
      }
    }

    // The FOREIGN attachment must SURVIVE (its blob is shared but the
    // ref-count check prevented the blob deletion).
    const foreign = await prisma.fileAttachment.findUniqueOrThrow({ where: { id: foreignAttachmentId } });
    expect(foreign.companyId).toBe(foreignCompanyId);

    // The SHARED BLOB must SURVIVE (B's shared attachment still references it)
    const blob = await prisma.fileBlob.findUniqueOrThrow({ where: { id: sharedBlobId } });
    expect(blob).toBeTruthy();

    // The foreign attachment is still DOWNLOADABLE (the blob is intact)
    const dl = await files!.downloadAttachment(foreignAttachmentId, foreignCompanyId);
    expect(dl.stream).toBeTruthy();

    // B's shared attachment must ALSO survive (same blob)
    const bShared = await prisma.fileAttachment.findFirstOrThrow({
      where: { entityType: 'sales_document', entityId: docIds[1], companyId: B, originalFilename: 'p3-shared-B.txt' },
    });
    expect(bShared).toBeTruthy();
  });
});
