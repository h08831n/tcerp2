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
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let service: ImportsService;
  const jobIds: string[] = [];
  const partyIds: string[] = [];
  const companyIds: string[] = [];

  const cleanup = async () => {
    for (const jobId of jobIds) {
      await prisma.importJobRow.deleteMany({ where: { jobId } }).catch(() => undefined);
      await prisma.importJob.delete({ where: { id: jobId } }).catch(() => undefined);
    }
    await prisma.party.deleteMany({ where: { id: { in: partyIds } } }).catch(() => undefined);
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
      ['شرکت سالم', 'COMPANY', '09121110001'],
      ['', 'COMPANY', '09121110002'],
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
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ الف', '09122220001'],
      ['شرکت گ۱۱ بد', 'BAD-NUMBER'], // pre-validation would catch; force via mapping skip: use phone2? keep simple: this row is INVALID at validation
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
        payload: { nameFa: 'شرکت گ۱۱ هم‌شماره', phone: '09122220001' } as Prisma.InputJsonValue,
      },
    });
    const finished = await service.run(INTEGRATION_COMPANY_ID, job.id, ACTOR, ctx);
    expect(finished.status).toBe('PARTIALLY_FAILED'); // 1 duplicate
    expect(finished.okCount).toBe(1);
    expect(finished.duplicateCount).toBe(1);
    const created = await prisma.party.findFirst({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: 'شرکت گ۱۱ الف' },
      select: { id: true, phones: { select: { normalizedValue: true } } },
    });
    expect(created).not.toBeNull();
    if (created) {
      partyIds.push(created.id);
      expect(created.phones[0]?.normalizedValue).toBe('09122220001');
    }
    // exactly ONE party for the colliding phone — dedup held
    const count = await prisma.party.count({
      where: { companyId: INTEGRATION_COMPANY_ID, phones: { some: { normalizedValue: '09122220001' } } },
    });
    expect(count).toBe(1);
  });

  it('g11-03 idempotent re-run: a completed job run again processes nothing new', async () => {
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ تکرار', '09122220003'],
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
      where: { companyId: INTEGRATION_COMPANY_ID, phones: { some: { normalizedValue: '09122220003' } } },
    });
    expect(stillOne).toBe(1);
  });

  it('g11-04 crash-resume: PENDING rows survive and a re-run processes ONLY them', async () => {
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ رزومه ۱', '09122220004'],
      ['شرکت گ۱۱ رزومه ۲', '09122220005'],
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
        phones: { create: { companyId: INTEGRATION_COMPANY_ID, kind: 'MOBILE', rawValue: '09122220006', normalizedValue: '09122220006' } },
      },
      select: { id: true },
    });
    partyIds.push(existing.id);
    const csv = csvOf([
      ['nameFa', 'phone'],
      ['شرکت گ۱۱ به‌روزشده', '09122220006'],
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
});
