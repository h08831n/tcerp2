import { Injectable, Logger } from '@nestjs/common';
import { ImportEntityType, ImportJobStatus, ImportRowStatus, PartyType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { normalizeIranMobile, normalizePhone } from '../common/utils/phone';
import { normalizeHeader, toCsv } from '../common/utils/csv';
import { CreateImportJobDto, ImportJobQueryDto } from './imports.dto';

/** PARTY import field whitelist + per-field validation (handover §31). */
const PARTY_FIELDS = [
  'nameFa',
  'nameEn',
  'type',
  'nationalId',
  'economicCode',
  'phone',
  'phone2',
] as const;
type PartyField = (typeof PARTY_FIELDS)[number];

function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Import engine (Phase 11, Gate G — handover §31): durable, RESUMABLE CSV
 * import with pre-run validation, per-row error reporting, natural-key
 * deduplication, an explicit commit policy (PER_ROW default / BATCH) and
 * batch-scoped commits — a huge file never lives inside one giant
 * transaction. Progress counters persist on the job row after every batch,
 * so a crashed run resumes exactly at the first PENDING row.
 */
@Injectable()
export class ImportsService {
  private readonly logger = new Logger('ImportsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ───────────────────── create + validate ─────────────────────

  async createJob(
    companyId: string,
    dto: CreateImportJobDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Prisma.ImportJobGetPayload<{ include: { _count: { select: { rows: true } } } }>> {
    if (dto.entityType !== 'PARTY') {
      throw new ValidationError('IMPORT_ENTITY_TYPE_UNSUPPORTED', { entityType: dto.entityType });
    }
    const commitMode = dto.commitMode === 'BATCH' ? 'BATCH' : 'PER_ROW';
    const batchSize = Math.min(Math.max(Math.floor(dto.batchSize ?? 500), 1), 5000);
    const updateMatched = dto.updateMatched === true;

    // ── parse + map ──
    const { parseCsv } = await import('../common/utils/csv');
    const grid = parseCsv(dto.csv);
    if (grid.length < 2) {
      throw new ValidationError('IMPORT_CSV_NEEDS_HEADER_AND_ROW');
    }
    const headers = grid[0].map(normalizeHeader);
    const mapping = dto.columnMapping ?? {};
    // columnMapping: {field: csvHeader}. Normalize both sides for matching.
    const headerIndex = new Map<string, number>();
    headers.forEach((h, i) => {
      if (!headerIndex.has(h)) headerIndex.set(h, i);
    });
    const fieldToIndex = new Map<PartyField, number>();
    for (const [field, header] of Object.entries(mapping)) {
      if (!(PARTY_FIELDS as readonly string[]).includes(field)) {
        throw new ValidationError('IMPORT_UNKNOWN_FIELD', { field });
      }
      const idx = headerIndex.get(normalizeHeader(header));
      if (idx === undefined) {
        throw new ValidationError('IMPORT_MAPPING_HEADER_NOT_FOUND', { field, header });
      }
      fieldToIndex.set(field as PartyField, idx);
    }
    if (!fieldToIndex.has('nameFa')) {
      throw new ValidationError('IMPORT_NAMEFA_MAPPING_REQUIRED');
    }

    // ── validate every row BEFORE anything is written ──
    const dataRows = grid.slice(1);
    if (dataRows.length > 20_000) {
      throw new ValidationError('IMPORT_TOO_MANY_ROWS', { max: 20_000 });
    }
    const rowPayloads: Array<{ payload: Record<string, string>; error: string | null }> =
      dataRows.map((cells, index) => {
        const get = (field: PartyField): string => {
          const idx = fieldToIndex.get(field);
          return idx === undefined ? '' : String(cells[idx] ?? '').trim();
        };
        const payload: Record<string, string> = {};
        for (const field of PARTY_FIELDS) {
          const value = get(field);
          if (value) payload[field] = value;
        }
        // per-row validation (PARTY rules)
        if (!payload.nameFa) return { payload, error: 'NAME_FA_REQUIRED' };
        if (payload.type && payload.type !== 'PERSON' && payload.type !== 'COMPANY') {
          return { payload, error: 'INVALID_PARTY_TYPE' };
        }
        for (const phoneField of ['phone', 'phone2'] as const) {
          if (payload[phoneField]) {
            try {
              payload[phoneField] = normalizePhone('MOBILE', payload[phoneField]);
            } catch {
              // landlines are legal in phone2 — normalize leniently there
              if (phoneField === 'phone') return { payload, error: 'INVALID_PHONE' };
              try {
                payload[phoneField] = normalizePhone('PHONE', payload[phoneField]);
              } catch {
                return { payload, error: 'INVALID_PHONE' };
              }
            }
          }
        }
        if (payload.nationalId && !/^\d{10,11}$/.test(payload.nationalId)) {
          return { payload, error: 'INVALID_NATIONAL_ID' };
        }
        if (payload.economicCode && !/^\d{9,12}$/.test(payload.economicCode)) {
          return { payload, error: 'INVALID_ECONOMIC_CODE' };
        }
        return { payload, error: null };
      });

    const failedCount = rowPayloads.filter((r) => r.error).length;
    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.importJob.create({
        data: {
          companyId,
          entityType: ImportEntityType.PARTY,
          fileName: dto.fileName?.slice(0, 200) || 'import.csv',
          status: ImportJobStatus.VALIDATED,
          totalRows: dataRows.length,
          failedCount,
          commitMode,
          batchSize,
          options: { updateMatched } as Prisma.InputJsonValue,
          columnMapping: dto.columnMapping as Prisma.InputJsonValue,
          createdById: actor.id,
        },
      });
      // chunked row inserts (20k rows in one INSERT list would exceed limits)
      for (let i = 0; i < rowPayloads.length; i += 500) {
        await tx.importJobRow.createMany({
          data: rowPayloads.slice(i, i + 500).map((row, offset) => ({
            jobId: created.id,
            rowIndex: i + offset,
            status: row.error ? ImportRowStatus.FAILED : ImportRowStatus.PENDING,
            payload: row.payload as Prisma.InputJsonValue,
            error: row.error,
          })),
        });
      }
      await this.auditService.recordTx(tx, {
        entityType: 'import_job',
        entityId: created.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: {
          entityType: 'PARTY',
          totalRows: dataRows.length,
          failedCount,
          commitMode,
          updateMatched,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return created;
    });

    return this.getJob(companyId, job.id);
  }

  // ───────────────────── run (resumable) ─────────────────────

  /**
   * Execute the validated job. RESUMABLE: only PENDING rows are processed,
   * counters persist after every batch, and a re-run after a crash (or a
   * PARTIALLY_FAILED job) continues exactly where it stopped. Commit policy:
   * PER_ROW (default — one short transaction per row, a bad row never hurts
   * its neighbours) or BATCH (all-or-nothing per chunk, documented tradeoff).
   */
  async run(
    companyId: string,
    jobId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Prisma.ImportJobGetPayload<{ include: { _count: { select: { rows: true } } } }>> {
    const job = await this.getJob(companyId, jobId);
    // COMPLETED/PARTIALLY_FAILED re-runs are LEGAL and idempotent: with no
    // PENDING rows they process nothing and return the persisted counters —
    // an operator retry after an ambiguous network failure is always safe.
    if (job.status === ImportJobStatus.CANCELLED || job.status === ImportJobStatus.FAILED) {
      throw new ValidationError('IMPORT_JOB_NOT_RUNNABLE', { status: job.status });
    }

    if (job.status !== ImportJobStatus.RUNNING) {
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: { status: ImportJobStatus.RUNNING, startedAt: job.startedAt ?? new Date(), finishedAt: null },
      });
    }

    const options = (job.options ?? {}) as { updateMatched?: boolean };
    const updateMatched = options.updateMatched === true;
    const chunkSize = Math.max(job.batchSize, 1);

    // Process until no PENDING rows remain (batch after durable batch).
    for (;;) {
      const batch = await this.prisma.importJobRow.findMany({
        where: { jobId: job.id, status: ImportRowStatus.PENDING },
        orderBy: { rowIndex: 'asc' },
        take: chunkSize,
      });
      if (batch.length === 0) break;

      let ok = 0;
      let updated = 0;
      let failed = 0;
      let duplicates = 0;

      if (job.commitMode === 'BATCH') {
        try {
          const outcome = await this.prisma.$transaction(async (tx) => {
            let o = { ok: 0, updated: 0, duplicates: 0 };
            for (const row of batch) {
              o = await this.processRow(tx, companyId, row.rowIndex, row.payload as Record<string, string>, updateMatched, o);
            }
            return o;
          });
          ok = outcome.ok;
          updated = outcome.updated;
          duplicates = outcome.duplicates;
          await this.prisma.importJobRow.updateMany({
            where: { id: { in: batch.map((r) => r.id) } },
            data: { status: ImportRowStatus.OK },
          });
        } catch (error) {
          // BATCH policy: one bad row fails the whole chunk (explicit tradeoff)
          const message = error instanceof Error ? error.message : String(error);
          failed = batch.length;
          await this.prisma.importJobRow.updateMany({
            where: { id: { in: batch.map((r) => r.id) } },
            data: { status: ImportRowStatus.FAILED, error: message.slice(0, 500) },
          });
        }
      } else {
        // PER_ROW: each row commits independently — neighbours survive a bad row.
        for (const row of batch) {
          try {
            const outcome = await this.prisma.$transaction(async (tx) =>
              this.processRow(tx, companyId, row.rowIndex, row.payload as Record<string, string>, updateMatched, {
                ok: 0,
                updated: 0,
                duplicates: 0,
              }),
            );
            await this.prisma.importJobRow.update({
              where: { id: row.id },
              data: {
                status: outcome.duplicates > 0 ? ImportRowStatus.DUPLICATE : ImportRowStatus.OK,
              },
            });
            ok += outcome.ok;
            updated += outcome.updated;
            duplicates += outcome.duplicates;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await this.prisma.importJobRow.update({
              where: { id: row.id },
              data: { status: ImportRowStatus.FAILED, error: message.slice(0, 500) },
            });
            failed += 1;
          }
        }
      }

      // Durable progress after EVERY batch — the crash-resume anchor.
      await this.prisma.importJob.update({
        where: { id: job.id },
        data: {
          okCount: { increment: ok },
          updatedCount: { increment: updated },
          duplicateCount: { increment: duplicates },
          failedCount: { increment: failed },
        },
      });
    }

    const fresh = await this.prisma.importJob.findUniqueOrThrow({ where: { id: job.id } });
    const terminal =
      fresh.failedCount > 0 || fresh.duplicateCount > 0
        ? ImportJobStatus.PARTIALLY_FAILED
        : ImportJobStatus.COMPLETED;
    const finished = await this.prisma.importJob.update({
      where: { id: job.id },
      data: { status: terminal, finishedAt: new Date() },
    });
    await this.auditService.record({
      entityType: 'import_job',
      entityId: job.id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: { status: job.status },
      newValues: {
        status: terminal,
        ok: fresh.okCount,
        updated: fresh.updatedCount,
        failed: fresh.failedCount,
        duplicates: fresh.duplicateCount,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ...finished, _count: { rows: fresh.totalRows } };
  }

  /**
   * One row's business write (inside the caller's transaction): dedupe by
   * normalized phone (the CRM's duplicate authority), update when
   * updateMatched, otherwise create the party (+ phones).
   */
  private async processRow(
    tx: Prisma.TransactionClient,
    companyId: string,
    rowIndex: number,
    payload: Record<string, string>,
    updateMatched: boolean,
    counters: { ok: number; updated: number; duplicates: number },
  ): Promise<{ ok: number; updated: number; duplicates: number }> {
    const phone = payload.phone || null;
    let existingId: string | null = null;
    if (phone) {
      const existing = await tx.party.findFirst({
        where: { companyId, phones: { some: { normalizedValue: phone } } },
        select: { id: true },
      });
      existingId = existing?.id ?? null;
    }
    if (existingId) {
      if (!updateMatched) {
        return { ...counters, duplicates: counters.duplicates + 1 };
      }
      await tx.party.update({
        where: { id: existingId },
        data: {
          nameFa: payload.nameFa,
          ...(payload.nameEn ? { nameEn: payload.nameEn } : {}),
          ...(payload.type ? { type: payload.type as PartyType } : {}),
          ...(payload.nationalId ? { nationalId: payload.nationalId } : {}),
          ...(payload.economicCode ? { economicCode: payload.economicCode } : {}),
        },
      });
      return { ...counters, ok: counters.ok + 1, updated: counters.updated + 1 };
    }
    const phoneCreates: Array<{
      companyId: string;
      kind: 'MOBILE' | 'PHONE';
      rawValue: string;
      normalizedValue: string;
    }> = [];
    if (phone) {
      phoneCreates.push({ companyId, kind: 'MOBILE', rawValue: payload.phone, normalizedValue: phone });
    }
    if (payload.phone2) {
      phoneCreates.push({
        companyId,
        kind: 'PHONE',
        rawValue: payload.phone2,
        normalizedValue: normalizePhone('PHONE', payload.phone2),
      });
    }
    await tx.party.create({
      data: {
        companyId,
        nameFa: payload.nameFa,
        ...(payload.nameEn ? { nameEn: payload.nameEn } : {}),
        type: (payload.type as PartyType) || PartyType.COMPANY,
        ...(payload.nationalId ? { nationalId: payload.nationalId } : {}),
        ...(payload.economicCode ? { economicCode: payload.economicCode } : {}),
        phones: { create: phoneCreates },
      },
    });
    return { ...counters, ok: counters.ok + 1 };
  }

  // ───────────────────── queries ─────────────────────

  async getJob(
    companyId: string,
    id: string,
  ): Promise<Prisma.ImportJobGetPayload<{ include: { _count: { select: { rows: true } } } }>> {
    const job = await this.prisma.importJob.findUnique({
      where: { id },
      include: { _count: { select: { rows: true } } },
    });
    if (!job || job.companyId !== companyId) {
      throw new NotFoundError('Import job not found', { id });
    }
    return job;
  }

  async listJobs(companyId: string, query: ImportJobQueryDto): Promise<Paginated<Prisma.ImportJobGetPayload<{ include: { _count: { select: { rows: true } } } }>>> {
    const where: Prisma.ImportJobWhereInput = { companyId, status: query.status };
    const [items, total] = await Promise.all([
      this.prisma.importJob.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { _count: { select: { rows: true } } },
      }),
      this.prisma.importJob.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Per-row error report (the handover's «نمایش خطاهای هر ردیف»). */
  async jobRows(companyId: string, jobId: string, onlyProblems: boolean) {
    await this.getJob(companyId, jobId);
    return this.prisma.importJobRow.findMany({
      where: { jobId, ...(onlyProblems ? { status: { not: ImportRowStatus.OK } } : {}) },
      orderBy: { rowIndex: 'asc' },
      take: 1000,
    });
  }

  async cancel(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const job = await this.getJob(companyId, id);
    if (job.status === ImportJobStatus.COMPLETED || job.status === ImportJobStatus.CANCELLED) {
      throw new ValidationError('IMPORT_JOB_NOT_CANCELLABLE', { status: job.status });
    }
    await this.prisma.importJob.update({
      where: { id: job.id },
      data: { status: ImportJobStatus.CANCELLED, finishedAt: new Date() },
    });
    await this.auditService.record({
      entityType: 'import_job',
      entityId: job.id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: { status: job.status },
      newValues: { status: 'CANCELLED' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  // ───────────────────── sample + export ─────────────────────

  /** CSV sample (handover: دانلود نمونه فایل) — header + one example row. */
  sampleCsv(entityType: string): string {
    if (entityType !== 'PARTY') {
      throw new ValidationError('IMPORT_ENTITY_TYPE_UNSUPPORTED', { entityType });
    }
    return toCsv([
      ['nameFa', 'nameEn', 'type', 'nationalId', 'economicCode', 'phone', 'phone2'],
      ['شرکت فولاد آریا', 'Aria Steel', 'COMPANY', '10101234567', '411151234567', '09121234567', '02188776655'],
      ['اصغر محمدی', '', 'PERSON', '', '', '09127654321', ''],
    ]);
  }

  /**
   * Export parties as CSV — company-wide DELIBERATELY (operator data dump);
   * gated by imports.export which only managers hold (OWN-scope bypass is
   * documented, not accidental).
   */
  async exportPartiesCsv(companyId: string): Promise<string> {
    const parties = await this.prisma.party.findMany({
      where: { companyId, archivedAt: null },
      orderBy: { nameFa: 'asc' },
      select: {
        nameFa: true,
        nameEn: true,
        type: true,
        nationalId: true,
        economicCode: true,
        archivedAt: true,
        phones: { select: { kind: true, normalizedValue: true } },
      },
    });
    const rows: Array<Array<string | number | null>> = [
      ['nameFa', 'nameEn', 'type', 'nationalId', 'economicCode', 'mobile', 'phone'],
    ];
    for (const p of parties) {
      rows.push([
        p.nameFa,
        p.nameEn,
        p.type,
        p.nationalId,
        p.economicCode,
        p.phones.find((ph) => ph.kind === 'MOBILE')?.normalizedValue ?? null,
        p.phones.find((ph) => ph.kind === 'PHONE')?.normalizedValue ?? null,
      ]);
    }
    return toCsv(rows);
  }
}
