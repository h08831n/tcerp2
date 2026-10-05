import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError } from '../common/errors';
import { jalaliYear } from '../common/utils/jalali';
import { RequestContext } from '../auth/auth.service';
import { Sequence } from '@prisma/client';

/** QueuePriority-like ordering is irrelevant here; this is the numbering engine. */

/**
 * Format a sequence number from its config.
 *   `${prefix}${includeJalaliYear ? '-' + jy : ''}-${padded}`
 * e.g. SD-1405-00125
 */
export function formatSequence(
  sequence: Pick<Sequence, 'prefix' | 'padding' | 'includeJalaliYear'>,
  currentNumber: number,
  date: Date,
): string {
  const jy = jalaliYear(date);
  const padded = String(currentNumber).padStart(sequence.padding, '0');
  return `${sequence.prefix}${sequence.includeJalaliYear ? `-${jy}` : ''}-${padded}`;
}

/**
 * Whether the counter should reset for the given date: only when
 * `resetYearly` and the stored `lastResetYear` differs from the date's
 * Jalali year (or was never set).
 */
export function shouldResetYearly(
  sequence: Pick<Sequence, 'resetYearly' | 'lastResetYear'>,
  date: Date,
): boolean {
  if (!sequence.resetYearly) return false;
  const jy = jalaliYear(date);
  return sequence.lastResetYear === null || sequence.lastResetYear !== jy;
}

export interface AllocatedSequence {
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
   * Atomically allocate the next number for a sequence code.
   *
   * Concurrency-safe: `SELECT … FOR UPDATE` row lock inside a transaction, so
   * two concurrent allocations can never produce the same number (REQUIREMENTS
   * §69). Optionally usable inside a caller's transaction via `tx`.
   */
  async allocate(
    code: string,
    tx?: Prisma.TransactionClient,
    date: Date = new Date(),
  ): Promise<AllocatedSequence> {
    const run = async (trx: Prisma.TransactionClient): Promise<AllocatedSequence> => {
      // Row-level lock; waits until concurrent allocators commit.
      const rows = await trx.$queryRaw<{ current_number: number; last_reset_year: number | null }[]>`
        SELECT "current_number", "last_reset_year" FROM "sequences" WHERE "code" = ${code} FOR UPDATE
      `;
      if (rows.length === 0) {
        throw new NotFoundError('Sequence not found', { code });
      }

      const config = await trx.sequence.findUniqueOrThrow({ where: { code } });
      const reset = shouldResetYearly(config, date);
      const nextNumber = reset ? 1 : rows[0].current_number + 1;
      const jy = jalaliYear(date);

      await trx.sequence.update({
        where: { code },
        data: {
          currentNumber: nextNumber,
          lastResetYear: config.resetYearly ? jy : config.lastResetYear,
        },
      });

      return {
        number: formatSequence(config, nextNumber, date),
        value: nextNumber,
      };
    };

    return tx ? run(tx) : this.prisma.$transaction((trx) => run(trx));
  }

  async list(): Promise<Sequence[]> {
    return this.prisma.sequence.findMany({ orderBy: { code: 'asc' } });
  }

  /**
   * Update prospective configuration only — `currentNumber` history is NEVER
   * rewritten (REQUIREMENTS §69: existing documents must never renumber).
   */
  async updateConfig(
    id: string,
    data: { prefix?: string; padding?: number; includeJalaliYear?: boolean; resetYearly?: boolean },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Sequence> {
    const existing = await this.prisma.sequence.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Sequence not found', { id });

    const updated = await this.prisma.sequence.update({
      where: { id },
      data: {
        prefix: data.prefix,
        padding: data.padding,
        includeJalaliYear: data.includeJalaliYear,
        resetYearly: data.resetYearly,
      },
    });
    await this.auditService.record({
      entityType: 'sequence',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      oldValues: {
        prefix: existing.prefix,
        padding: existing.padding,
        includeJalaliYear: existing.includeJalaliYear,
        resetYearly: existing.resetYearly,
      },
      newValues: {
        prefix: updated.prefix,
        padding: updated.padding,
        includeJalaliYear: updated.includeJalaliYear,
        resetYearly: updated.resetYearly,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }
}
