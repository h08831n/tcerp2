import { Injectable } from '@nestjs/common';
import { AccountingEventType, PostingMeasure, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConflictError, NotFoundError } from '../common/errors';

type Tx = Prisma.TransactionClient;

export interface UpsertRuleInput {
  code: string;
  nameFa: string;
  eventType: AccountingEventType;
  enabled?: boolean;
  lines?: { side: 'DEBIT' | 'CREDIT'; accountCode: string; measure: string; memo?: string; order?: number }[];
}

/**
 * Configurable posting rules (Phase 7B-6): which accounts an operational
 * event hits, per company. Measures (RECEIVABLE/REVENUE/COGS/INVENTORY/
 * PAYABLE) are resolved to amounts by the event engine at emit time.
 */
@Injectable()
export class PostingRuleService {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string) {
    return this.prisma.postingRule.findMany({
      where: { companyId },
      orderBy: { code: 'asc' },
      include: { lines: { orderBy: { order: 'asc' } } },
    });
  }

  async upsert(companyId: string, input: UpsertRuleInput, actor: { id: string; username: string }) {
    const lines = (input.lines ?? []).map((l, i) => ({
      side: l.side,
      accountCode: l.accountCode,
      measure: l.measure as PostingMeasure,
      memo: l.memo ?? null,
      order: l.order ?? i + 1,
    }));
    const rule = await this.prisma.postingRule.upsert({
      where: { companyId_code: { companyId, code: input.code } },
      create: {
        companyId,
        code: input.code,
        nameFa: input.nameFa,
        eventType: input.eventType,
        enabled: input.enabled ?? true,
        lines: { create: lines },
      },
      update: {
        nameFa: input.nameFa,
        eventType: input.eventType,
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        version: { increment: 1 },
        ...(lines.length > 0
          ? { lines: { deleteMany: {}, create: lines } }
          : {}),
      },
      include: { lines: { orderBy: { order: 'asc' } } },
    });
    void actor;
    return rule;
  }

  async setEnabled(companyId: string, id: string, enabled: boolean, actor: { id: string; username: string }) {
    const rule = await this.prisma.postingRule.findFirst({ where: { id, companyId } });
    if (!rule) throw new NotFoundError('Posting rule not found', { id });
    if (rule.enabled === enabled) return rule;
    const updated = await this.prisma.$transaction(async (tx: Tx) => {
      const row = await tx.postingRule.update({ where: { id }, data: { enabled } });
      await tx.auditLog.create({
        data: {
          companyId,
          entityType: 'posting_rule',
          entityId: id,
          action: 'UPDATE',
          actorId: actor.id,
          actorName: actor.username,
          oldValues: { enabled: rule.enabled } as Prisma.InputJsonValue,
          newValues: { enabled } as Prisma.InputJsonValue,
        },
      });
      return row;
    });
    return updated;
  }
}
