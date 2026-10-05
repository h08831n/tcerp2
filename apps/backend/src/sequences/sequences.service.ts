import { Injectable } from '@nestjs/common';
import { Prisma, Sequence } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { toJalali } from '../common/utils/jalali';
import { RequestContext } from '../auth/auth.service';
import { CreateSequenceDto, UpdateSequenceDto } from './sequences.dto';

/** Company-scoped numbering engine (REQUIREMENTS §69, correction gate v2). */

export const FISCAL_YEAR_START_SETTING = 'accounting.fiscal_year_start_mmdd';
export const FISCAL_YEAR_START_FALLBACK = '01-01';

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Compute the reset marker for a date and cycle:
 *   JALALI_YEAR  → "1405"
 *   MONTHLY      → "1405-07"
 *   FISCAL_YEAR  → "FY-2026" (fiscal year the date belongs to, given the
 *                  company's `accounting.fiscal_year_start_mmdd` setting)
 *   NEVER        → null
 */
export function computeResetMarker(
  resetCycle: Sequence['resetCycle'],
  date: Date,
  fiscalYearStartMmdd: string,
): string | null {
  switch (resetCycle) {
    case 'JALALI_YEAR': {
      const { jy } = toJalali(date);
      return String(jy);
    }
    case 'MONTHLY': {
      const { jy, jm } = toJalali(date);
      return `${jy}-${pad2(jm)}`;
    }
    case 'FISCAL_YEAR': {
      const gy = date.getFullYear();
      const mm = pad2(date.getMonth() + 1);
      const dd = pad2(date.getDate());
      const start = /^\d{2}-\d{2}$/.test(fiscalYearStartMmdd)
        ? fiscalYearStartMmdd
        : FISCAL_YEAR_START_FALLBACK;
      const fiscalYear = `${mm}-${dd}` >= start ? gy : gy - 1;
      return `FY-${fiscalYear}`;
    }
    default:
      return null;
  }
}

/**
 * Document number format: `${prefix}-${marker compacted}-${padded}`.
 * JALALI_YEAR with marker "1405" yields `SD-1405-00001`; NEVER yields `SD-00001`.
 */
export function formatSequence(
  sequence: Pick<Sequence, 'prefix' | 'padding' | 'resetCycle'>,
  currentNumber: number,
  marker: string | null,
): string {
  const padded = String(currentNumber).padStart(sequence.padding, '0');
  return `${sequence.prefix}-${marker ? marker.replace(/-/g, '') + '-' : ''}${padded}`;
}

export interface AllocatedSequence {
  companyId: string;
  documentType: string;
  number: string;
  value: number;
}

@Injectable()
export class SequencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Atomically allocate the next number for (companyId, documentType).
   *
   * Concurrency-safe: `SELECT … FOR UPDATE` on the single row inside a
   * transaction, so two concurrent allocations can never produce the same
   * number. Usable inside a caller's transaction via `tx`.
   */
  async allocate(
    companyId: string,
    documentType: string,
    tx?: Prisma.TransactionClient,
    date: Date = new Date(),
  ): Promise<AllocatedSequence> {
    const run = async (trx: Prisma.TransactionClient): Promise<AllocatedSequence> => {
      // Row-level lock; waits until concurrent allocators commit.
      const rows = await trx.$queryRaw<{ current_number: number; last_reset_marker: string | null }[]>`
        SELECT "current_number", "last_reset_marker" FROM "sequences"
        WHERE "company_id" = ${companyId}::uuid AND "document_type" = ${documentType}
        FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new NotFoundError('Sequence not found', { companyId, documentType });
      }

      const config = await trx.sequence.findUniqueOrThrow({
        where: { companyId_documentType: { companyId, documentType } },
      });

      const fiscalStart = await this.fiscalYearStart(companyId, trx);
      const marker = computeResetMarker(config.resetCycle, date, fiscalStart);
      const reset = marker !== config.lastResetMarker && marker !== null;
      const nextNumber = reset ? 1 : rows[0].current_number + 1;

      await trx.sequence.update({
        where: { companyId_documentType: { companyId, documentType } },
        data: {
          currentNumber: nextNumber,
          lastResetMarker: marker !== null ? marker : config.lastResetMarker,
        },
      });

      return {
        companyId,
        documentType,
        number: formatSequence(config, nextNumber, marker),
        value: nextNumber,
      };
    };

    return tx ? run(tx) : this.prisma.$transaction((trx) => run(trx));
  }

  private async fiscalYearStart(
    companyId: string,
    trx: Prisma.TransactionClient,
  ): Promise<string> {
    const setting = await trx.setting.findUnique({
      where: { companyId_key: { companyId, key: FISCAL_YEAR_START_SETTING } },
      select: { value: true },
    });
    const value = setting?.value;
    if (typeof value === 'string' && /^\d{2}-\d{2}$/.test(value)) return value;
    if (value && typeof value === 'object' && 'mmdd' in (value as object)) {
      const mmdd = (value as { mmdd?: unknown }).mmdd;
      if (typeof mmdd === 'string' && /^\d{2}-\d{2}$/.test(mmdd)) return mmdd;
    }
    return FISCAL_YEAR_START_FALLBACK;
  }

  async list(companyId: string): Promise<Sequence[]> {
    return this.prisma.sequence.findMany({
      where: { companyId },
      orderBy: { documentType: 'asc' },
    });
  }

  async createConfig(
    companyId: string,
    dto: CreateSequenceDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Sequence> {
    const existing = await this.prisma.sequence.findUnique({
      where: { companyId_documentType: { companyId, documentType: dto.documentType } },
    });
    if (existing) {
      throw new ConflictError('A sequence for this document type already exists', {
        companyId,
        documentType: dto.documentType,
      });
    }
    const created = await this.prisma.sequence.create({
      data: {
        companyId,
        documentType: dto.documentType,
        name: dto.name,
        prefix: dto.prefix,
        padding: dto.padding ?? 5,
        resetCycle: dto.resetCycle ?? 'NEVER',
      },
    });
    await this.auditService.record({
      entityType: 'sequence',
      entityId: created.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { documentType: created.documentType, prefix: created.prefix, padding: created.padding, resetCycle: created.resetCycle },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return created;
  }

  /**
   * Update prospective configuration only — `currentNumber`/`lastResetMarker`
   * history is NEVER rewritten (existing documents are never renumbered).
   */
  async updateConfig(
    companyId: string,
    id: string,
    dto: UpdateSequenceDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Sequence> {
    const existing = await this.prisma.sequence.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Sequence not found', { id });
    if (existing.companyId !== companyId) {
      throw new NotFoundError('Sequence not found', { id });
    }

    const updated = await this.prisma.sequence.update({
      where: { id },
      data: {
        name: dto.name,
        prefix: dto.prefix,
        padding: dto.padding,
        resetCycle: dto.resetCycle,
      },
    });
    await this.auditService.record({
      entityType: 'sequence',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: {
        name: existing.name,
        prefix: existing.prefix,
        padding: existing.padding,
        resetCycle: existing.resetCycle,
      },
      newValues: {
        name: updated.name,
        prefix: updated.prefix,
        padding: updated.padding,
        resetCycle: updated.resetCycle,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }
}
