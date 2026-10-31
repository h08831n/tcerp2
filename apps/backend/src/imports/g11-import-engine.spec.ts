import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ImportsService } from './imports.service';
import {
  TEST_INTEGRATION,
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(180000);

const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000f1', username: 'importer' };
const ctx = {} as never;

function csvOf(rows: string[][]): string {
  return rows.map((r) => r.join(',')).join('\r\n');
}

/**
 * g11 — Phase 11 (Gate G) import engine: pre-run validation, phone-key
 * dedup, PER_ROW vs BATCH commit policies, crash-resume, updateMatched and
 * company-scoped export.
 */
describeIntegration('g11 import engine (Phase 11)', () => {
  const marker = `g11-${Date.now()}`;
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let service: ImportsService;
  const jobIds: string[] = [];
  const partyIds: string[] = [];
  const companyIds: string[] = [];
  const dailyPriceIds: string[] = [];
  const variantIds: string[] = [];
  const templateIds: string[] = [];
  const categoryIds: string[] = [];
  const uomCategoryIds: string[] = [];
  const uomIds: string[] = [];
  const userIds: string[] = [];

  // Per-run unique phone generator — crashed runs leave orphans in the shared
  // test company, so static phones would collide (unique per company+phone).
  const phoneBase = 9110000000 + (Date.now() % 1_000_000); // 10 digits
  const phone = (n: number): string => `0${phoneBase + n}`; // 0 + 10 digits = 11

  const cleanup = async () => {
    for (const jobId of jobIds) {
      await prisma.importJobRow.deleteMany({ where: { jobId } }).catch(() => undefined);
      await prisma.importJob.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    await prisma.party.deleteMany({ where: { id: { in: partyIds } } }).catch(() => undefined);
    await prisma.party.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, phones: { some: { normalizedValue: { startsWith: `0${phoneBase}` } } } },
    }).catch(() => undefined);
    await prisma.dailyPrice.deleteMany({ where: { id: { in: dailyPriceIds } } }).catch(() => undefined);
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { id: { in: templateIds } } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { id: { in: categoryIds } } }).catch(() => undefined);
    await prisma.uom.deleteMany({ where: { id: { in: uomIds } } }).catch(() => undefined);
    await prisma.uomCategory.deleteMany({ where: { id: { in: uomCategoryIds } } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    await prisma.company.deleteMany({ where: { id: { in: companyIds } } }).catch(() => undefined);
  };

  beforeAll(async () => {
    prismaService = new PrismaService();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    service = new ImportsService(prismaService, new AuditService(prismaService));
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  it('g11-01 create + validate: bad rows marked FAILED before anything runs; missing nameFa mapping rejected', async () => {
    const csv = csvOf([
      ['nameFa', 'type', 'phone'],
      ['شرکت سالم', 'COMPANY', phone(101)],
      ['', 'COMPANY', phone(102)],
      ['تلفن بد', 'COMPANY', '12345'],
      ['نوع بد', 'GHOST', ''],
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      { entityType: 'PARTY', fileName: 'g11-validation.csv', csv, columnMapping: { nameFa: 'nameFa', type: 'type', phone: 'phone' } },
      ACTOR,
      ctx,
    );
    jobIds.push(job.id);
    expect(job.status).toBe('VALIDATED');
    expect(job.totalRows).toBe(4);
    expect(job.failedCount).toBe(3);
    const rows = await service.jobRows(INTEGRATION_COMPANY_ID, job.id, true);
    const errors = rows.filter((r) => r.error).map((r) => r.error);
    expect(errors).toContain('NAME_FA_REQUIRED');
    expect(errors).toContain('INVALID_PHONE');
    expect(errors).toContain('INVALID_PARTY_TYPE');

    // nameFa mapping is mandatory
    await expect(
      service.createJob(
        INTEGRATION_COMPANY_ID,
        { entityType: 'PARTY', csv: 'a,b\n1,2', columnMapping: { type: 'a' } },
        ACTOR, ctx,
      ),
    ).rejects.toMatchObject({ message: 'IMPORT_NAMEFA_MAPPING_REQUIRED' });
    // mapped header must exist in the CSV
    await expect(
      service.createJob(
        INTEGRATION_COMPANY_ID,
        { entityType: 'PARTY', csv: 'a,b\n1,2', columnMapping: { nameFa: 'ghost' } },
        ACTOR, ctx,
      ),
    ).rejects.toMatchObject({ message: 'IMPORT_MAPPING_HEADER_NOT_FOUND' });
  });

  it('g11-02 PER_ROW run creates parties with canonical phones; row-level failure spares neighbours', async () => {
    // self-clean: crashed earlier runs may leave same-prefix parties
    await prisma.party.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { startsWith: 'شرکت گ۱۱ الف-' } },
    }).catch(() => undefined);
    const alfName = `شرکت گ۱۱ الف-${Date.now()}`;
    const csv = csvOf([
      ['nameFa', 'phone'],
      [alfName, phone(1)],
      ['شرکت گ۱۱ بد', 'BAD-NUMBER'],
    ]);
    // NOTE: invalid phone rows fail VALIDATION, so to test a RUNTIME failure use
    // a row that passes validation but fails at write time — a duplicate
    // phone is DUPLICATE (not failure); runtime failure path: force via
    // direct row payload tampering below.
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PARTY',
        fileName: 'g11-perrow.csv',
        csv,
        columnMapping: { nameFa: 'nameFa', phone: 'phone' },
        commitMode: 'PER_ROW',
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    // tamper: the second row passes validation only if its phone were valid;
    // instead replace the second row's payload with a valid phone that will
    // collide mid-run with the FIRST row's phone (duplicate within the file).
    await prisma.importJobRow.update({
      where: { jobId_rowIndex: { jobId: job.id, rowIndex: 1 } },
      data: {
        status: 'PENDING',
        error: null,
        payload: { nameFa: 'شرکت گ۱۱ هم‌شماره', phone: phone(1) } as Prisma.InputJsonValue,
      },
    });
    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(finished.status).toBe('PARTIALLY_FAILED'); // 1 duplicate
    expect(finished.okCount).toBe(1);
    expect(finished.duplicateCount).toBe(1);
    const created = await prisma.party.findFirst({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: alfName },
      select: { id: true, phones: { select: { normalizedValue: true } } },
    });
    expect(created).not.toBeNull();
    if (created) {
      partyIds.push(created.id);
      expect(created.phones[0]?.normalizedValue).toBe(phone(1));
    }
    // exactly ONE party for the colliding phone — dedup held
    const count = await prisma.party.count({
      where: { companyId: INTEGRATION_COMPANY_ID, phones: { some: { normalizedValue: phone(1) } } },
    });
    expect(count).toBe(1);
  });

  it('g11-03 idempotent re-run: a completed job run again processes nothing new', async () => {
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ تکرار', phone(3)],
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      { entityType: 'PARTY', fileName: 'g11-idem.csv', csv, columnMapping: { nameFa: 'nameFa', phone: 'phone' } },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    const created = await prisma.party.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: 'شرکت گ۱۱ تکرار' },
      select: { id: true },
    });
    partyIds.push(created.id);
    const reRun = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(reRun.okCount).toBe(1); // unchanged — no PENDING rows
    const stillOne = await prisma.party.count({
      where: { companyId: INTEGRATION_COMPANY_ID, phones: { some: { normalizedValue: phone(3) } } },
    });
    expect(stillOne).toBe(1);
  });

  it('g11-04 crash-resume: PENDING rows survive and a re-run processes ONLY them', async () => {
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ رزومه ۱', phone(4)],
      ['شرکت گ۱۱ رزومه ۲', phone(5)],
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      { entityType: 'PARTY', fileName: 'g11-resume.csv', csv, columnMapping: { nameFa: 'nameFa', phone: 'phone' } },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    // simulate a crash: row 0 done, row 1 left PENDING
    await prisma.importJobRow.update({
      where: { jobId_rowIndex: { jobId: job.id, rowIndex: 0 } },
      data: { status: 'OK' },
    });
    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', okCount: 1 },
    });
    const resumed = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.okCount).toBe(2);
    const second = await prisma.party.findFirst({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: 'شرکت گ۱۱ رزومه ۲' },
      select: { id: true },
    });
    expect(second).not.toBeNull();
    if (second) partyIds.push(second.id);
  });

  it('g11-05 updateMatched: existing phone updates the party; without it the row is DUPLICATE', async () => {
    // seed an existing party with the phone
    const existing = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        nameFa: 'شرکت گ۱۱ موجود',
        type: 'COMPANY',
        phones: { create: { companyId: INTEGRATION_COMPANY_ID, kind: 'MOBILE', rawValue: phone(6), normalizedValue: phone(6) } },
      },
      select: { id: true },
    });
    partyIds.push(existing.id);
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ به‌روزشده', phone(6)],
    ]);

    // updateMatched=false → DUPLICATE, party untouched
    const dupJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      { entityType: 'PARTY', fileName: 'g11-dup.csv', csv, columnMapping: { nameFa: 'nameFa', phone: 'phone' }, updateMatched: false },
      ACTOR, ctx,
    );
    jobIds.push(dupJob.id);
    const dupRun = await service.run(INTEGRATION_COMPANY_ID, dupJob.id, ACTOR, ctx);
    expect(dupRun.duplicateCount).toBe(1);
    const untouched = await prisma.party.findUniqueOrThrow({ where: { id: existing.id }, select: { nameFa: true } });
    expect(untouched.nameFa).toBe('شرکت گ۱۱ موجود');

    // updateMatched=true → row OK with updated flag
    const updJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      { entityType: 'PARTY', fileName: 'g11-upd.csv', csv, columnMapping: { nameFa: 'nameFa', phone: 'phone' }, updateMatched: true },
      ACTOR, ctx,
    );
    jobIds.push(updJob.id);
    const updRun = await service.run(INTEGRATION_COMPANY_ID, updJob.id, ACTOR, ctx);
    expect(updRun.updatedCount).toBe(1);
    const updated = await prisma.party.findUniqueOrThrow({ where: { id: existing.id }, select: { nameFa: true } });
    expect(updated.nameFa).toBe('شرکت گ۱۱ به‌روزشده');
  });

  it('g11-06 BATCH policy: chunk is all-or-nothing (explicit documented tradeoff)', async () => {
    const stamp = `${Date.now()}`.slice(-8);
    const batchPhone = `0912${stamp}1`; // per-run unique: earlier debugging runs leave stale rows
    const csv = csvOf([
      ['nameFa', 'phone'],
      [`شرکت گ۱۱ بچ ۱-${stamp}`, batchPhone],
      [`شرکت گ۱۱ بچ ۲-${stamp}`, batchPhone], // same phone in one BATCH chunk
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PARTY', fileName: 'g11-batch.csv', csv,
        columnMapping: { nameFa: 'nameFa', phone: 'phone' },
        commitMode: 'BATCH', batchSize: 10,
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    // Deterministic write-time failure inside the chunk: tamper one row's
    // payload with a type value that fails the enum cast AND no phone (the
    // engine's in-tx dedup would otherwise catch the same-phone row as a
    // DUPLICATE — that protection is correct, so bypass it here).
    await prisma.importJobRow.update({
      where: { jobId_rowIndex: { jobId: job.id, rowIndex: 1 } },
      data: { payload: { nameFa: 'شرکت گ۱۱ بچ ۲', type: 'GHOST' } as Prisma.InputJsonValue },
    });
    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(finished.failedCount).toBe(2); // whole chunk rolled back
    const none = await prisma.party.count({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        OR: [
          { phones: { some: { normalizedValue: batchPhone } } },
          { nameFa: { contains: `گ۱۱ بچ ۱-${stamp}` } },
        ],
      },
    });
    expect(none).toBe(0); // BATCH = all-or-nothing (documented tradeoff)
  });

  it('g11-07 export: company-scoped CSV (foreign companies absent) with canonical phones', async () => {
    const other = await prisma.company.create({
      data: { nameFa: `g11-other-${Date.now()}`, status: 'ACTIVE' },
      select: { id: true },
    });
    companyIds.push(other.id);
    const foreign = await prisma.party.create({
      data: { companyId: other.id, nameFa: 'شرکت خارجی g11', type: 'COMPANY' },
      select: { id: true },
    });
    partyIds.push(foreign.id);
    const csv = await service.exportPartiesCsv(INTEGRATION_COMPANY_ID);
    expect(csv).toContain('شرکت گ۱۱ الف');
    expect(csv).not.toContain('شرکت خارجی g11');
  });

  it('g11-08 sample + permissions: sample CSV carries the canonical headers; roles seeded', async () => {
    const sample = service.sampleCsv('PARTY');
    expect(sample).toContain('nameFa,nameEn,type,nationalId,economicCode,phone,phone2');
    expect(() => service.sampleCsv('GHOST')).toThrow('IMPORT_ENTITY_TYPE_UNSUPPORTED');
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: 'imports.run' },
      select: { id: true },
    });
    const salesManager = await prisma.role.findUniqueOrThrow({
      where: { code: 'sales_manager' },
      select: { permissions: { select: { permissionId: true } } },
    });
    expect(salesManager.permissions.some((p) => p.permissionId === permission.id)).toBe(true);
    const salesperson = await prisma.role.findUniqueOrThrow({
      where: { code: 'salesperson' },
      select: { permissions: { select: { permissionId: true } } },
    });
    expect(salesperson.permissions.some((p) => p.permissionId === permission.id)).toBe(false);
  });

  it('g11-09 DAILY_PRICE import: pre-validated references, natural-key upsert both ways', async () => {
    const { seededUoms, createVariantEx } = await import('../integrity-gate/g6-helpers');
    const uoms = await seededUoms(prisma);
    const variant = await createVariantEx(prisma, `${marker}-price`, {
      defaultUomId: uoms.tonId,
      inventoryUomId: uoms.tonId,
    });
    variantIds.push(variant.variantId);
    const variantSku = (await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.variantId },
      select: { sku: true },
    })).sku;
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

    // validation: unknown sku / bad date / bad price / bad uom caught BEFORE run
    const badCsv = csvOf([
      ['variantSku', 'date', 'price', 'uomSymbol'],
      ['GHOST-SKU', today, '35000', ''],
      [variantSku, '2026-13-99', '35000', ''],
      [variantSku, today, '-5', ''],
      [variantSku, today, '35000', 'GHOST-UOM'],
    ]);
    const badJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'DAILY_PRICE', fileName: 'g11-price-bad.csv', csv: badCsv,
        columnMapping: { variantSku: 'variantSku', date: 'date', price: 'price', uomSymbol: 'uomSymbol' },
      },
      ACTOR, ctx,
    );
    jobIds.push(badJob.id);
    expect(badJob.failedCount).toBe(4);
    const badRows = await service.jobRows(INTEGRATION_COMPANY_ID, badJob.id, true);
    const badErrors = badRows.map((r) => r.error);
    expect(badErrors).toContain('VARIANT_NOT_FOUND');
    expect(badErrors).toContain('INVALID_DATE');
    expect(badErrors).toContain('INVALID_PRICE');
    expect(badErrors).toContain('UOM_NOT_FOUND');

    // lifecycle: create + same-natural-key duplicate (updateMatched=false)
    const csv = csvOf([
      ['variantSku', 'date', 'price', 'uomSymbol'],
      [variantSku, today, '35000', ''],
      [variantSku, yesterday, '34000', ''],
      [variantSku, yesterday, '34500', ''],
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'DAILY_PRICE', fileName: 'g11-price.csv', csv,
        columnMapping: { variantSku: 'variantSku', date: 'date', price: 'price', uomSymbol: 'uomSymbol' },
        updateMatched: false,
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    const firstRun = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(firstRun.status).toBe('PARTIALLY_FAILED');
    expect(firstRun.okCount).toBe(2);
    expect(firstRun.duplicateCount).toBe(1);
    const created = await prisma.dailyPrice.findFirstOrThrow({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        productVariantId: variant.variantId,
        date: new Date(`${yesterday}T00:00:00Z`),
      },
      select: { id: true, price: true, source: true },
    });
    dailyPriceIds.push(created.id);
    expect(created.price.toString()).toBe('34000');
    expect(created.source).toBe('IMPORTED');

    // updateMatched re-import updates the price on the SAME natural key
    const updCsv = csvOf([
      ['variantSku', 'date', 'price'],
      [variantSku, yesterday, '35500'],
    ]);
    const updJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'DAILY_PRICE', fileName: 'g11-price-upd.csv', csv: updCsv,
        columnMapping: { variantSku: 'variantSku', date: 'date', price: 'price' },
        updateMatched: true,
      },
      ACTOR, ctx,
    );
    jobIds.push(updJob.id);
    const updRun = await service.run(INTEGRATION_COMPANY_ID, updJob.id, ACTOR, ctx);
    expect(updRun.updatedCount).toBe(1);
    const updated = await prisma.dailyPrice.findUniqueOrThrow({ where: { id: created.id }, select: { price: true } });
    expect(updated.price.toString()).toBe('35500');
  });

  it('g11-10 load smoke: 1500-row party import completes with 100% OK (scale sanity)', async () => {
    const stamp = `${Date.now()}`.slice(-7);
    const base = 1_000_000 + (Number(stamp) % 1_000_000);
    const rows: string[][] = [['nameFa', 'phone']];
    for (let i = 0; i < 1500; i += 1) {
      rows.push([`g11-load-${stamp}-${i}`, `0915${String(base + i).padStart(7, '0')}`]);
    }
    const started = Date.now();
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PARTY', fileName: `g11-load-${stamp}.csv`, csv: csvOf(rows),
        columnMapping: { nameFa: 'nameFa', phone: 'phone' },
        commitMode: 'PER_ROW', batchSize: 500,
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    const seconds = (Date.now() - started) / 1000;
    expect(finished.okCount).toBe(1500);
    expect(finished.failedCount).toBe(0);
    expect(finished.status).toBe('COMPLETED');
    // scale sanity (NOT a benchmark): 1500 rows inside a bounded window
    expect(seconds).toBeLessThan(120);
    // eslint-disable-next-line no-console
    console.log(`[g11-10] load smoke: 1500 rows in ${seconds.toFixed(1)}s (${(1500 / seconds).toFixed(0)} rows/s)`);
    await prisma.party
      .deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { startsWith: `g11-load-${stamp}` } } })
      .catch(() => undefined);
  });

  it('g11-11 XLSX import: base64 workbook parses through the same engine (PARTY)', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    const excelName = `شرکت گ۱۱ اکسل-${Date.now()}`;
    await prisma.party.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { startsWith: 'شرکت گ۱۱ اکسل-' } },
    }).catch(() => undefined);
    const sheet = workbook.addWorksheet('Parties');
    sheet.addRow(['nameFa', 'phone']);
    sheet.addRow([excelName, phone(11)]);
    sheet.addRow(['', phone(12)]); // invalid row — validation must catch it too
    const buffer = await workbook.xlsx.writeBuffer();
    const xlsxBase64 = Buffer.from(buffer).toString('base64');

    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PARTY',
        fileName: 'g11-excel.xlsx',
        xlsxBase64,
        columnMapping: { nameFa: 'nameFa', phone: 'phone' },
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    expect(job.totalRows).toBe(2);
    expect(job.failedCount).toBe(1); // the empty-name row validated FAILED from the XLSX grid
    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(finished.okCount).toBe(1);
    const created = await prisma.party.findFirst({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: excelName },
      select: { id: true, phones: { select: { normalizedValue: true } } },
    });
    expect(created).not.toBeNull();
    if (created) {
      partyIds.push(created.id);
      expect(created.phones[0]?.normalizedValue).toBe(phone(11));
    }
    // both inputs at once → rejected
    await expect(
      service.createJob(
        INTEGRATION_COMPANY_ID,
        {
          entityType: 'PARTY', fileName: 'x', csv: 'nameFa,x', xlsxBase64,
          columnMapping: { nameFa: 'nameFa' },
        },
        ACTOR, ctx,
      ),
    ).rejects.toMatchObject({ message: 'IMPORT_INPUT_REQUIRED' });
    // garbage base64 → IMPORT_XLSX_UNREADABLE
    await expect(
      service.createJob(
        INTEGRATION_COMPANY_ID,
        { entityType: 'PARTY', fileName: 'x', xlsxBase64: 'not-a-workbook' },
        ACTOR, ctx,
      ),
    ).rejects.toMatchObject({ message: 'IMPORT_XLSX_UNREADABLE' });
  });

  it('g11-12 health: liveness ok + queue observability counters present', async () => {
    const health = (prismaService as unknown as {
      $queryRaw: typeof prisma.$queryRaw;
    });
    void health;
    // direct controller-level check via a fresh PrismaService (public route)
    const { HealthController } = await import('../health/health.controller');
    const controller = new HealthController(prismaService);
    const response = { status: () => response, send: () => undefined } as never;
    const payload = (await controller.check(response)) as {
      status: string;
      database: string;
      queue: { pending: number; scheduled: number; failed: number } | null;
    };
    expect(payload.status).toBe('ok');
    expect(payload.database).toBe('up');
    expect(payload.queue).not.toBeNull();
    expect(typeof payload.queue!.pending).toBe('number');
  });

  it('g11-13 PRODUCT_VARIANT import: template-scoped creation + sku upsert both ways', async () => {
    // minimal template fixture (category + template with internalCode + uom)
    const uomCategory = await prisma.uomCategory.create({
      data: { companyId: INTEGRATION_COMPANY_ID, code: `G11VC-${Date.now()}`, nameFa: 'واحد گ۱۱' },
    });
    uomCategoryIds.push(uomCategory.id);
    const uom = await prisma.uom.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        categoryId: uomCategory.id,
        symbol: `T${Date.now() % 100000}`,
        nameFa: 'تن گ۱۱',
        conversionRatio: new Prisma.Decimal(1),
        isBaseUnit: true,
      },
    });
    uomIds.push(uom.id);
    const category = await prisma.productCategory.create({
      data: { companyId: INTEGRATION_COMPANY_ID, code: `G11CAT-${Date.now()}`, nameFa: 'دسته گ۱۱' },
    });
    categoryIds.push(category.id);
    const templateCode = `G11TPL-${Date.now()}`;
    const template = await prisma.productTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        categoryId: category.id,
        internalCode: templateCode,
        nameFa: 'قالب گ۱۱',
        defaultSalesUomId: uom.id,
      },
    });
    templateIds.push(template.id);

    // validation: unknown template / missing sku / missing nameFa caught pre-run
    const badCsv = csvOf([
      ['templateCode', 'sku', 'nameFa'],
      ['GHOST-TPL', 'SKU-A', 'نام'],
      [templateCode, '', 'نام'],
      [templateCode, 'SKU-B', ''],
    ]);
    const badJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PRODUCT_VARIANT', fileName: 'g11-var-bad.csv', csv: badCsv,
        columnMapping: { templateCode: 'templateCode', sku: 'sku', nameFa: 'nameFa' },
      },
      ACTOR, ctx,
    );
    jobIds.push(badJob.id);
    expect(badJob.failedCount).toBe(3);
    const badErrors = (await service.jobRows(INTEGRATION_COMPANY_ID, badJob.id, true)).map((r) => r.error);
    expect(badErrors).toContain('TEMPLATE_NOT_FOUND');
    expect(badErrors).toContain('SKU_REQUIRED');
    expect(badErrors).toContain('NAME_FA_REQUIRED');

    // lifecycle: create 2 variants (one with uom + weight), then re-import one
    // sku with updateMatched=false → DUPLICATE; with true → updated
    const csv = csvOf([
      ['templateCode', 'sku', 'nameFa', 'defaultUomSymbol', 'weightPerUnit', 'weightUomSymbol'],
      [templateCode, `G11V-${Date.now()}-A`, 'میلگرد ۱۴ گ۱۱', uom.symbol, '18.7', uom.symbol],
      [templateCode, `G11V-${Date.now()}-B`, 'میلگرد ۱۶ گ۱۱', '', '', ''],
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PRODUCT_VARIANT', fileName: 'g11-variants.csv', csv,
        columnMapping: {
          templateCode: 'templateCode', sku: 'sku', nameFa: 'nameFa',
          defaultUomSymbol: 'defaultUomSymbol', weightPerUnit: 'weightPerUnit', weightUomSymbol: 'weightUomSymbol',
        },
        updateMatched: false,
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    const firstRun = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(firstRun.status).toBe('COMPLETED');
    expect(firstRun.okCount).toBe(2);
    const created = await prisma.productVariant.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: 'میلگرد ۱۴ گ۱۱' },
      select: { id: true, sku: true, combinationKey: true, templateId: true, weightPerUnit: true, defaultUomId: true },
    });
    variantIds.push(created.id);
    expect(created.combinationKey).toBe(created.sku); // simple-import stand-in key
    expect(created.templateId).toBe(template.id);
    expect(created.weightPerUnit?.toString()).toBe('18.7');
    expect(created.defaultUomId).toBe(uom.id);

    // updateMatched=false on the same sku → DUPLICATE (no second variant)
    const dupCsv = csvOf([
      ['templateCode', 'sku', 'nameFa'],
      [templateCode, created.sku, 'نام تغییر'],
    ]);
    const dupJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PRODUCT_VARIANT', fileName: 'g11-var-dup.csv', csv: dupCsv,
        columnMapping: { templateCode: 'templateCode', sku: 'sku', nameFa: 'nameFa' },
        updateMatched: false,
      },
      ACTOR, ctx,
    );
    jobIds.push(dupJob.id);
    const dupRun = await service.run(INTEGRATION_COMPANY_ID, dupJob.id, ACTOR, ctx);
    expect(dupRun.duplicateCount).toBe(1);
    const stillSame = await prisma.productVariant.findUniqueOrThrow({
      where: { id: created.id }, select: { nameFa: true },
    });
    expect(stillSame.nameFa).toBe('میلگرد ۱۴ گ۱۱');

    // updateMatched=true → name updated
    const updJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PRODUCT_VARIANT', fileName: 'g11-var-upd.csv', csv: dupCsv,
        columnMapping: { templateCode: 'templateCode', sku: 'sku', nameFa: 'nameFa' },
        updateMatched: true,
      },
      ACTOR, ctx,
    );
    jobIds.push(updJob.id);
    const updRun = await service.run(INTEGRATION_COMPANY_ID, updJob.id, ACTOR, ctx);
    expect(updRun.updatedCount).toBe(1);
    const updated = await prisma.productVariant.findUniqueOrThrow({
      where: { id: created.id }, select: { nameFa: true },
    });
    expect(updated.nameFa).toBe('نام تغییر');
  });

  it('g11-14 SALES_DOCUMENT import: consecutive-row grouping, DRAFT creation, number dedupe', async () => {
    // fixture: customer with mobile + variant + salesperson user
    const docPhone = `0917${String(Date.now()).slice(-7)}`; // per-run unique mobile
    const customer = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        type: 'COMPANY',
        nameFa: `g11-doc-customer-${Date.now()}`,
        roles: { create: [{ role: 'CUSTOMER' }] },
        phones: { create: { companyId: INTEGRATION_COMPANY_ID, kind: 'MOBILE', rawValue: docPhone, normalizedValue: docPhone } },
      },
      select: { id: true },
    });
    partyIds.push(customer.id);
    const uoms = await (await import('../integrity-gate/g6-helpers')).seededUoms(prisma);
    const variant = await (await import('../integrity-gate/g6-helpers')).createVariantEx(prisma, `${marker}-doc`, {
      defaultUomId: uoms.tonId,
      inventoryUomId: uoms.tonId,
    });
    variantIds.push(variant.variantId);
    const variantSku = (await prisma.productVariant.findUniqueOrThrow({
      where: { id: variant.variantId }, select: { sku: true },
    })).sku;
    // membership only — the document import checks ACTIVE + membership,
    // not a specific role (SALESPERSON role assertion is the UI path).
    const salesperson = await prisma.user.create({
      data: {
        username: `g11-doc-sales-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE',
        companies: { create: { companyId: INTEGRATION_COMPANY_ID } },
      },
      select: { id: true, username: true },
    });
    userIds.push(salesperson.id);

    // CSV: doc-1 has TWO lines (consecutive rows); doc-2 one line; one unknown
    // customer; one repeated doc-1 number in a LATER (non-consecutive) group
    const docNumber = `P10SD-${Date.now()}`;
    const doc2Number = `P10SD-2-${Date.now()}`;
    const csv = csvOf([
      ['documentNumber', 'customerPhone', 'documentDate', 'salespersonUsername', 'variantSku', 'quantity', 'unitPrice'],
      [docNumber, docPhone, '2026-10-30', salesperson.username, variantSku, '10', '35000'],
      [docNumber, docPhone, '2026-10-30', salesperson.username, variantSku, '5', '35000'],
      [docNumber, docPhone, '2026-10-30', salesperson.username, variantSku, '2', '35000'],
      [doc2Number, docPhone, '2026-10-30', salesperson.username, variantSku, '1', '1000'],
      ['9991111222', '09999999999', '2026-10-30', salesperson.username, variantSku, '1', '1000'],
      [docNumber, docPhone, '2026-10-30', salesperson.username, variantSku, '1', '35000'],
    ]);
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'SALES_DOCUMENT', fileName: 'g11-docs.csv', csv,
        columnMapping: {
          documentNumber: 'documentNumber', customerPhone: 'customerPhone', documentDate: 'documentDate',
          salespersonUsername: 'salespersonUsername', variantSku: 'variantSku', quantity: 'quantity', unitPrice: 'unitPrice',
        },
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    // rows 1-2 of doc-1 were GROUPED at validation (consecutive same number)
    const groupedRow = (await service.jobRows(INTEGRATION_COMPANY_ID, job.id, false)).find(
      (r) => r.rowIndex === 1,
    );
    expect(groupedRow?.status).toBe('DUPLICATE');
    // head data-row 0 = spreadsheet row 2 (1-based, header offset)
    expect(groupedRow?.error).toContain('GROUPED_INTO_ROW_2');
    const repeatedRow = (await service.jobRows(INTEGRATION_COMPANY_ID, job.id, false)).find(
      (r) => r.rowIndex === 5,
    );
    expect(repeatedRow?.status).toBe('PENDING');

    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(finished.status).toBe('PARTIALLY_FAILED');
    // create-time failedCount (1 unknown-phone row) + run failures (0 — all
    // three PENDING heads succeeded) = 1.
    expect(finished.okCount).toBe(2); // doc-1 + doc-2 created
    expect(finished.duplicateCount).toBe(1); // row 5 repeat
    expect(finished.failedCount).toBe(1);

    expect(finished.duplicateCount).toBe(1); // row 5: doc-1 number already created

    // doc-1: THREE lines merged, DRAFT status, totals = (10+5+2) × 35000
    const doc = await prisma.salesDocument.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, documentNumber: docNumber },
      include: { lines: true },
    });
    expect(doc.status).toBe('DRAFT');
    expect(doc.lines).toHaveLength(3);
    expect(Number(doc.total)).toBe(17 * 35000);
    expect(doc.salespersonUserId).toBe(salesperson.id);
    expect(doc.customerPartyId).toBe(customer.id);
    // doc-2 created separately
    const doc2 = await prisma.salesDocument.count({
      where: { companyId: INTEGRATION_COMPANY_ID, documentNumber: doc2Number },
    });
    expect(doc2).toBe(1);

    // re-import same number → DUPLICATE (documents never updated by import)
    const dupJob = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'SALES_DOCUMENT', fileName: 'g11-docs-dup.csv', csv: csvOf([
          ['documentNumber', 'customerPhone', 'documentDate', 'salespersonUsername', 'variantSku', 'quantity', 'unitPrice'],
          [docNumber as string, docPhone, '2026-10-30', salesperson.username, variantSku, '1', '35000'],
        ]),
        columnMapping: {
          documentNumber: 'documentNumber', customerPhone: 'customerPhone', documentDate: 'documentDate',
          salespersonUsername: 'salespersonUsername', variantSku: 'variantSku', quantity: 'quantity', unitPrice: 'unitPrice',
        },
      },
      ACTOR, ctx,
    );
    jobIds.push(dupJob.id);
    const dupRun = await service.run(INTEGRATION_COMPANY_ID, dupJob.id, ACTOR, ctx);
    expect(dupRun.duplicateCount).toBe(1);
    const stillOne = await prisma.salesDocument.count({
      where: { companyId: INTEGRATION_COMPANY_ID, documentNumber: docNumber },
    });
    expect(stillOne).toBe(1);
  });

  it('g11-15 full load: 5000-row import completes 100% OK (Gate G scale gate)', async () => {
    const stamp = `${Date.now()}`.slice(-7);
    const base = 2_000_000 + (Number(stamp) % 1_000_000);
    const rows: string[][] = [['nameFa', 'phone']];
    for (let i = 0; i < 5000; i += 1) {
      rows.push([`g11-full-${stamp}-${i}`, `0918${String(base + i).padStart(7, '0')}`]);
    }
    const started = Date.now();
    const job = await service.createJob(
      INTEGRATION_COMPANY_ID,
      {
        entityType: 'PARTY', fileName: `g11-full-${stamp}.csv`, csv: csvOf(rows),
        columnMapping: { nameFa: 'nameFa', phone: 'phone' },
        commitMode: 'PER_ROW', batchSize: 500,
      },
      ACTOR, ctx,
    );
    jobIds.push(job.id);
    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    const seconds = (Date.now() - started) / 1000;
    expect(finished.okCount).toBe(5000);
    expect(finished.failedCount).toBe(0);
    expect(finished.status).toBe('COMPLETED');
    // scale gate: 5000 rows inside 5 minutes (dev-hardware bound, not prod)
    expect(seconds).toBeLessThan(300);
    // eslint-disable-next-line no-console
    console.log(`[g11-15] full load: 5000 rows in ${seconds.toFixed(1)}s (${(5000 / seconds).toFixed(0)} rows/s)`);
    await prisma.party
      .deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { startsWith: `g11-full-${stamp}` } } })
      .catch(() => undefined);
  });

  it('g11-16 concurrent jobs: two parallel imports never cross-contaminate rows', async () => {
    const stamp = `${Date.now()}`.slice(-7);
    const baseA = 3_000_000 + (Number(stamp) % 1_000_000);
    const baseB = 3_100_000 + (Number(stamp) % 1_000_000);
    const mkCsv = (prefix: string, base: number): string => {
      const rows: string[][] = [['nameFa', 'phone']];
      for (let i = 0; i < 100; i += 1) {
        rows.push([`${prefix}-${i}`, `0919${String(base + i).padStart(7, '0')}`]);
      }
      return csvOf(rows);
    };
    const [jobA, jobB] = await Promise.all([
      service.createJob(
        INTEGRATION_COMPANY_ID,
        {
          entityType: 'PARTY', fileName: `g11-conc-A-${stamp}.csv`, csv: mkCsv(`g11-conc-A-${stamp}`, baseA),
          columnMapping: { nameFa: 'nameFa', phone: 'phone' },
        },
        ACTOR, ctx,
      ),
      service.createJob(
        INTEGRATION_COMPANY_ID,
        {
          entityType: 'PARTY', fileName: `g11-conc-B-${stamp}.csv`, csv: mkCsv(`g11-conc-B-${stamp}`, baseB),
          columnMapping: { nameFa: 'nameFa', phone: 'phone' },
        },
        ACTOR, ctx,
      ),
    ]);
    jobIds.push(jobA.id, jobB.id);
    // run BOTH concurrently — separate transactions per row, no shared state
    const [finA, finB] = await Promise.all([
      service.run(INTEGRATION_COMPANY_ID, jobA.id, ACTOR, ctx),
      service.run(INTEGRATION_COMPANY_ID, jobB.id, ACTOR, ctx),
    ]);
    expect(finA.okCount).toBe(100);
    expect(finB.okCount).toBe(100);
    expect(finA.failedCount).toBe(0);
    expect(finB.failedCount).toBe(0);
    const countA = await prisma.party.count({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { startsWith: `g11-conc-A-${stamp}` } },
    });
    const countB = await prisma.party.count({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { startsWith: `g11-conc-B-${stamp}` } },
    });
    expect(countA).toBe(100);
    expect(countB).toBe(100);
    await prisma.party
      .deleteMany({
        where: {
          companyId: INTEGRATION_COMPANY_ID,
          OR: [
            { nameFa: { startsWith: `g11-conc-A-${stamp}` } },
            { nameFa: { startsWith: `g11-conc-B-${stamp}` } },
          ],
        },
      })
      .catch(() => undefined);
  });
});
