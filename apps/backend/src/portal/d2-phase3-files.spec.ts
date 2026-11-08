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
import { randomBytes, createHmac, createHash } from 'crypto';

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
 * D-2 Phase 3 (final) — customer portal FILES with THREE independent gates
 * (parent scope + parent status + customer visibility DEFAULT DENY), plus:
 *
 *   - SHARED BLOB dedup: two companies uploading the same content point to
 *     the SAME FileBlob (onDelete: Cascade); cleanup must NOT destroy the
 *     FOREIGN attachment via blob cascade (ref-count before blob delete).
 *   - FOREIGN protective fixture: a FileBlob + attachment owned by NO suite
 *     company must survive the entire suite (tripwire in afterAll).
 *   - MinIO contract: the probe consults the SAME loadConfig().S3_ENDPOINT
 *     FilesService uses; storage tests SKIP (Jest counter, NOT_TESTED in CI)
 *     when unreachable; when UP a REAL upload→download round-trip is the
 *     storage-coverage gate; when DOWN the upload failure is CLASSIFIED as
 *     a storage connect error + proven to leave ZERO orphan rows.
 *   - HTTP multipart with the production ValidationPipe: customerVisible
 *     is an @IsIn string converted in the service (multipart sends strings).
 */
// ── Module-scope sync MinIO probe → itStorage (SKIP if unreachable) ──
// The probe MUST consult the SAME config source FilesService uses —
// loadConfig() — not a raw process.env fallback that can drift from it
// (local compose maps MinIO to :9100 via .env; CI uses :9000). Probe hits
// 127.0.0.1 explicitly: localhost can resolve to ::1 on GH runners.
const CONFIG_S3_ENDPOINT = loadConfig().S3_ENDPOINT;
const PROBE_ENDPOINT = CONFIG_S3_ENDPOINT.replace(/\/$/, '').replace('localhost', '127.0.0.1');
let minioReachable = false;
try {
  require('child_process').execSync(
    `curl -sf --max-time 3 ${PROBE_ENDPOINT}/minio/health/live`,
    { timeout: 8000, stdio: 'pipe' },
  );
  minioReachable = true;
} catch { /* MinIO not reachable — S3 tests SKIP (Jest counter, never silent-pass) */ }
const itStorage = (TEST_INTEGRATION && DB_URL && minioReachable) ? it : it.skip;

describeIntegration('d2-phase3-files (real AppModule + MinIO + ValidationPipe)', () => {
  let prisma: PrismaService;
  let files: FilesService | null = null;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let A = '';
  let B = '';
  let adminToken = '';
  const marker = `p3-${Date.now()}`;
  // THE shared dedup content for THIS run only (A internal + B shared +
  // foreign fixture all upload it → exactly 3 attachments on one blob).
  const suiteSecret = `p3-secret-${marker}`;
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
      // INTERNAL attachment (customerVisible NOT set → DEFAULT DENY).
      // Content contract: A's internal carries THE suiteSecret — B's shared
      // upload and the foreign fixture reuse it for the dedup proof (exactly
      // 3 attachments on one blob). B's own internal is DIFFERENT content.
      // All marker-based: a FIXED shared string would accumulate previous
      // runs' attachments on the SAME blob (run-to-run contamination).
      const internalContent = label === 'A' ? suiteSecret : `p3-secret-${label}-${marker}`;
      const { attachment } = await files.upload(
        { buffer: Buffer.from(internalContent), originalname: `p3-${label}.txt`, mimetype: 'text/plain', size: Buffer.byteLength(internalContent) },
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
          { buffer: Buffer.from(suiteSecret), originalname: `p3-shared-B.txt`, mimetype: 'text/plain', size: Buffer.byteLength(suiteSecret) },
          { entityType: 'sales_document', entityId: doc.id, displayName: `shared ${label}` },
          cid, { id: admin.id, username: admin.username }, {},
        );
        // TRACK IT: this attachment was previously dropped from the cleanup
        // arrays — company B's delete then failed on its FK forever (silent
        // leftover company). The blob stays ref-count guarded: at suite-blob
        // cleanup time the FOREIGN attachment still references it (fixture
        // survival), so it is only deleted after the foreign cleanup.
        suiteAttachmentIds.push(foreignShared.id);
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
      { buffer: Buffer.from(suiteSecret), originalname: `p3-foreign-${marker}.txt`, mimetype: 'text/plain', size: Buffer.byteLength(suiteSecret) },
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
        if (!foreignBlobId) return;
        // D5-02 final: ref-count check — do NOT delete a blob that still
        // has attachments referencing it (content dedup → shared blob).
        const refCount = await prisma.fileAttachment.count({ where: { fileBlobId: foreignBlobId } });
        if (refCount === 0) {
          await prisma.fileBlob.delete({ where: { id: foreignBlobId } }).catch(() => undefined);
        }
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

  it('MinIO probe consistency: probe endpoint IS the S3_ENDPOINT FilesService loads', async () => {
    // REAL assertion (not a diagnostic pin): the module-scope probe must
    // have consulted the SAME config source the FilesService constructor
    // receives. Drift (probe on :9000 while config says :9100) would SKIP
    // storage tests that should RUN — or run tests against dead storage.
    expect(PROBE_ENDPOINT).toBe(CONFIG_S3_ENDPOINT.replace(/\/$/, '').replace('localhost', '127.0.0.1'));
    expect(PROBE_ENDPOINT).toBe(loadConfig().S3_ENDPOINT.replace(/\/$/, '').replace('localhost', '127.0.0.1'));
    // The beforeAll probe (async fetch, 127.0.0.1-forced) must AGREE with
    // the module probe (sync curl, 127.0.0.1-forced) — disagreement means
    // an unstable storage or a probe-source regression.
    expect(minioUp).toBe(minioReachable);
    console.warn(`[p3] MinIO ${minioUp ? 'UP — storage tests RUN' : 'DOWN — storage tests SKIP in Jest counter (NOT_TESTED)'}`);
  });

  it('MinIO DOWN: upload fails with a REAL storage connect error + ZERO orphan rows', async () => {
    if (minioUp) {
      console.warn('[p3] MinIO is UP — DOWN-state proof runs only when storage is unreachable');
      return;
    }
    // Unique content: a dedup hit (existing sha256) BYPASSES S3 entirely —
    // only a never-uploaded payload actually reaches the PutObject connect.
    const content = `p3-down-${randomBytes(12).toString('hex')}`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    // FilesService is null when storage is down — construct a temporary one
    // to prove the REAL S3 connection failure.
    const tempFiles = new FilesService(
      prisma as never,
      new AuditService(prisma as never),
      loadConfig(),
    );
    const err = await tempFiles.upload(
      { buffer: Buffer.from(content), originalname: 'down.txt', mimetype: 'text/plain', size: content.length },
      { entityType: 'sales_document', entityId: '00000000-0000-4000-8000-000000000001' },
      A, { id: createdUsers[0], username: 'admin' }, {},
    ).then(() => null, (e: unknown) => e);
    expect(err).toBeTruthy();
    // Classify the failure: it MUST be a storage CONNECT failure — never an
    // unrelated exception (validation/DB/business). PROVEN shapes (CI run
    // 138/139 vs local Node 24):
    //   - Node fetch path: TypeError 'fetch failed' + .cause chain with
    //     ECONNREFUSED codes.
    //   - Node 20 path: the refusal surfaces as an EMPTY-message
    //     AggregateError (String(err) === 'AggregateError') which @smithy's
    //     retry middleware wraps as Error('AWS SDK error wrapper for
    //     AggregateError'). 'AggregateError' with no message is Node's
    //     ALL-address-family connect refusal — a genuine storage connect
    //     failure — and the wrapper literal is emitted ONLY for transport
    //     errors, never business/DB/validation errors.
    const fragments: string[] = [];
    const visit = (e: unknown, depth: number): void => {
      if (e == null || depth > 5) return;
      const anyE = e as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown; errors?: unknown };
      if (typeof anyE.code === 'string') fragments.push(anyE.code);
      if (typeof anyE.name === 'string') fragments.push(anyE.name);
      if (typeof anyE.message === 'string') fragments.push(anyE.message);
      visit(anyE.cause, depth + 1);
      if (Array.isArray(anyE.errors)) for (const sub of anyE.errors) visit(sub, depth + 1);
    };
    visit(err, 0);
    const joined = fragments.join(' | ');
    expect(joined).toMatch(
      /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EPROTO|EAI_AGAIN|fetch failed|NetworkingError|socket hang up|AggregateError|AWS SDK error wrapper|connect/i,
    );
    // upload() writes the FileBlob row ONLY AFTER the S3 Put succeeds — a
    // failed upload must leave ZERO rows (no orphan blob, no attachment).
    expect(await prisma.fileBlob.count({ where: { sha256 } })).toBe(0);
  });

  itStorage('MinIO UP: REAL upload→download round-trip (byte-exact content + true size)', async () => {
    if (!minioUp) throw new Error('itStorage dispatched while MinIO DOWN — probe/dispatch drift');
    // A reachability probe alone proves nothing — this is the suite's REAL
    // storage-coverage gate: bytes must round-trip through S3 byte-exactly.
    const content = `p3-roundtrip-${randomBytes(12).toString('hex')}`;
    const { attachment, blob } = await files!.upload(
      { buffer: Buffer.from(content), originalname: 'roundtrip.txt', mimetype: 'text/plain', size: content.length },
      { entityType: 'sales_document', entityId: docIds[0] },
      A, { id: createdUsers[0], username: 'admin' }, {},
    );
    suiteAttachmentIds.push(attachment.id);
    suiteBlobIds.push(blob.id);
    // upload() returns the FileBlobDto — size is ALREADY the Number() form.
    // TRUE byte length (never the declared multipart size) survives both
    // the DB Decimal and the DTO conversion.
    expect(blob.size).toBe(content.length);
    const dl = await files!.download(blob.id, A);
    const chunks: Buffer[] = [];
    for await (const chunk of dl.stream as unknown as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString('utf8')).toBe(content);
    expect(dl.size).toBe(content.length);
  });

  // -------------------------------------- storage-backed tests (MinIO UP)

  itStorage('DEFAULT DENY: list shows ONLY the customer-visible attachment (internal invisible)', async () => {

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

  itStorage('DEFAULT DENY: INTERNAL attachment on the customer OWN order → NOT downloadable', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const dl = await portalGet(`/api/portal/files/${internalIds[A]}/download`, token);
    expect(dl.status).toBe(404);
  });

  itStorage('customer-VISIBLE attachment on the same order downloads with stored content', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet(`/api/portal/files/${visibleIds[A]}/download`, token);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('p3-visible-A');
  });

  itStorage('IDOR: downloading the OTHER company attachment with the A session → 404', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const token = await makeSession(portalAccountIds[0]);
    const res = await portalGet(`/api/portal/files/${internalIds[B]}/download`, token);
    expect(res.status).toBe(404);
  });

  itStorage('SHARED BLOB: both attachments point to the SAME FileBlob (content dedup)', async () => {
    if (!minioUp) { console.warn('[p3] SKIP — MinIO DOWN (storage NOT_TESTED in CI)'); return; }
    const refCount = await prisma.fileAttachment.count({ where: { fileBlobId: sharedBlobId } });
    expect(refCount).toBe(3); // A internal + B shared + foreign — SAME blob
  });

  // --------------------------------- foreign protective fixture (MinIO UP)

  itStorage('FOREIGN FIXTURE: same content from foreign company → SAME blob (dedup, verified in beforeAll)', async () => {
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

  itStorage('CLEANUP TEST: suite-scoped cleanup does NOT destroy the foreign attachment or shared blob', async () => {
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

    // The SHARED BLOB must SURVIVE — the FOREIGN attachment still references
    // it, so the ref-count check prevented the deletion. (B's OWN shared
    // attachment is suite-tracked and IS deleted by the cleanup above; the
    // blob's life is now owned by the foreign fixture — that is exactly the
    // protection the ref-count provides.)
    const blob = await prisma.fileBlob.findUniqueOrThrow({ where: { id: sharedBlobId } });
    expect(blob).toBeTruthy();

    // The foreign attachment is still DOWNLOADABLE (the blob is intact)
    const dl = await files!.downloadAttachment(foreignAttachmentId, foreignCompanyId);
    expect(dl.stream).toBeTruthy();
  });
});
