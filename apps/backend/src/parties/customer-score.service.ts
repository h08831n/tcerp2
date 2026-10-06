import { Injectable } from '@nestjs/common';
import { Prisma, ScoreLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotFoundError } from '../common/errors';
import { TimelineService } from './timeline.service';

export const SCORE_RULES_SETTING_KEY = 'crm.score_rules';

export interface ScoreWeights {
  profit: number;
  tonnage: number;
  purchaseCount: number;
  paidAmount: number;
  recency: number;
  frequency: number;
}

export interface ScoreThresholds {
  vip: number;
  platinum: number;
  gold: number;
  silver: number;
}

export interface ScoreCaps {
  profit: number;
  tonnage: number;
  purchaseCount: number;
  paidAmount: number;
  /** Days of inactivity that map to recency contribution 0. */
  recency: number;
  frequency: number;
}

export interface ScoreRules {
  weights: ScoreWeights;
  thresholds: ScoreThresholds;
  caps: ScoreCaps;
}

export interface ScoreMetrics {
  operationalProfit: number;
  tonnage: number;
  purchaseCount: number;
  paidAmount: number;
  recencyDays: number;
  frequency: number;
}

export const DEFAULT_SCORE_RULES: ScoreRules = {
  weights: {
    profit: 0.25,
    tonnage: 0.2,
    purchaseCount: 0.15,
    paidAmount: 0.2,
    recency: 0.1,
    frequency: 0.1,
  },
  thresholds: { vip: 900, platinum: 750, gold: 600, silver: 400 },
  caps: {
    profit: 1_000_000_000,
    tonnage: 1000,
    purchaseCount: 50,
    paidAmount: 1_000_000_000,
    recency: 365,
    frequency: 24,
  },
};

/**
 * Pure score computation (unit-tested without a DB):
 *   score = 1000 · Σ weight_k · normalize(metric_k)
 * where each metric is clamped to [0, 1] against a cap (recency inverted:
 * fresher is better). Level comes from the configured thresholds.
 */
export function computeScore(
  metrics: ScoreMetrics,
  rules: ScoreRules,
): { score: number; level: ScoreLevel } {
  const caps = { ...DEFAULT_SCORE_RULES.caps, ...rules.caps };
  const w = { ...DEFAULT_SCORE_RULES.weights, ...rules.weights };
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const safeDiv = (value: number, cap: number) => (cap > 0 ? value / cap : 0);

  const raw =
    w.profit * clamp01(safeDiv(metrics.operationalProfit, caps.profit)) +
    w.tonnage * clamp01(safeDiv(metrics.tonnage, caps.tonnage)) +
    w.purchaseCount * clamp01(safeDiv(metrics.purchaseCount, caps.purchaseCount)) +
    w.paidAmount * clamp01(safeDiv(metrics.paidAmount, caps.paidAmount)) +
    w.recency * clamp01(1 - safeDiv(metrics.recencyDays, caps.recency)) +
    w.frequency * clamp01(safeDiv(metrics.frequency, caps.frequency));
  const score = Math.round(raw * 1000);

  const t = { ...DEFAULT_SCORE_RULES.thresholds, ...rules.thresholds };
  const level: ScoreLevel =
    score >= t.vip
      ? ScoreLevel.VIP
      : score >= t.platinum
        ? ScoreLevel.PLATINUM
        : score >= t.gold
          ? ScoreLevel.GOLD
          : score >= t.silver
            ? ScoreLevel.SILVER
            : ScoreLevel.BRONZE;
  return { score, level };
}

function finite(value: unknown, fallback: number): number {
  const n = typeof value === 'string' ? Number(value) : (value as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Company rules from the `crm.score_rules` Setting; defaults when absent. */
export function mergeScoreRules(settingValue: unknown): ScoreRules {
  if (!settingValue || typeof settingValue !== 'object') {
    return JSON.parse(JSON.stringify(DEFAULT_SCORE_RULES)) as ScoreRules;
  }
  const raw = settingValue as {
    weights?: Partial<ScoreWeights>;
    thresholds?: Partial<ScoreThresholds>;
    caps?: Partial<ScoreCaps>;
  };
  const defaults = DEFAULT_SCORE_RULES;
  return {
    weights: {
      profit: finite(raw.weights?.profit, defaults.weights.profit),
      tonnage: finite(raw.weights?.tonnage, defaults.weights.tonnage),
      purchaseCount: finite(raw.weights?.purchaseCount, defaults.weights.purchaseCount),
      paidAmount: finite(raw.weights?.paidAmount, defaults.weights.paidAmount),
      recency: finite(raw.weights?.recency, defaults.weights.recency),
      frequency: finite(raw.weights?.frequency, defaults.weights.frequency),
    },
    thresholds: {
      vip: finite(raw.thresholds?.vip, defaults.thresholds.vip),
      platinum: finite(raw.thresholds?.platinum, defaults.thresholds.platinum),
      gold: finite(raw.thresholds?.gold, defaults.thresholds.gold),
      silver: finite(raw.thresholds?.silver, defaults.thresholds.silver),
    },
    caps: {
      profit: finite(raw.caps?.profit, defaults.caps.profit),
      tonnage: finite(raw.caps?.tonnage, defaults.caps.tonnage),
      purchaseCount: finite(raw.caps?.purchaseCount, defaults.caps.purchaseCount),
      paidAmount: finite(raw.caps?.paidAmount, defaults.caps.paidAmount),
      recency: finite(raw.caps?.recency, defaults.caps.recency),
      frequency: finite(raw.caps?.frequency, defaults.caps.frequency),
    },
  };
}

/**
 * Customer score (REQUIREMENTS §4). Metrics come from sales/purchase/finance
 * data that does not exist yet (Phase 4 sales, Phase 7 balances) — every
 * metric is 0 today and the computation is already wired so later phases
 * only need to fill `gatherMetrics`. Weights/thresholds live in the company
 * Setting `crm.score_rules`, never hard-coded.
 */
@Injectable()
export class CustomerScoreService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly timeline: TimelineService,
  ) {}

  async getRules(companyId: string): Promise<ScoreRules> {
    const setting = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: SCORE_RULES_SETTING_KEY } },
      select: { value: true },
    });
    return mergeScoreRules(setting?.value);
  }

  /**
   * Metrics available NOW: purchaseCount, paidAmount, tonnage, operational
   * profit and frequency are all 0 until Phase 4 (sales) and Phase 7
   * (balances/invoices) land; recency is 0 for the same reason. Documented
   * placeholder — later phases replace this method body only.
   */
  private async gatherMetrics(
    _companyId: string,
    _partyId: string,
  ): Promise<ScoreMetrics> {
    return {
      operationalProfit: 0,
      tonnage: 0,
      purchaseCount: 0,
      paidAmount: 0,
      recencyDays: 0,
      frequency: 0,
    };
  }

  async compute(
    companyId: string,
    partyId: string,
    actor?: { id: string; username: string },
    note?: string,
  ): Promise<{ partyId: string; score: number; level: ScoreLevel; metrics: ScoreMetrics }> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId },
      select: { id: true, nameFa: true },
    });
    if (!party) {
      throw new NotFoundError('Party not found', { partyId });
    }

    const [rules, metrics] = await Promise.all([
      this.getRules(companyId),
      this.gatherMetrics(companyId, partyId),
    ]);
    const { score, level } = computeScore(metrics, rules);
    const computedAt = new Date();

    await this.prisma.$transaction(async (trx) => {
      await trx.customerScoreHistory.create({
        data: {
          companyId,
          partyId,
          score,
          level,
          metrics: metrics as unknown as Prisma.InputJsonValue,
          computedAt,
          computedBy: actor?.id ?? null,
          note,
        },
      });
      await trx.party.update({
        where: { id: partyId },
        data: { score, scoreLevel: level },
      });
      // Routine event → hidden from the shared timeline (noise control);
      // visible with includeHidden for scope-ALL / audit.view holders.
      await this.timeline.record(trx, {
        companyId,
        entityType: 'PARTY',
        entityId: partyId,
        type: 'SCORE_RECOMPUTED',
        title: 'بازمحاسبه امتیاز مشتری',
        description: party.nameFa,
        data: { partyId, score, level, metrics },
        actorType: actor ? 'USER' : 'SYSTEM',
        actorUserId: actor?.id ?? null,
        visible: false,
      });
    });

    return { partyId, score, level, metrics };
  }

  async getScore(
    companyId: string,
    partyId: string,
  ): Promise<{
    partyId: string;
    score: number | null;
    scoreLevel: ScoreLevel | null;
    history: {
      score: number;
      level: ScoreLevel;
      metrics: unknown;
      computedAt: Date;
      note: string | null;
    }[];
  }> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId },
      select: { id: true, score: true, scoreLevel: true },
    });
    if (!party) {
      throw new NotFoundError('Party not found', { partyId });
    }
    const history = await this.prisma.customerScoreHistory.findMany({
      where: { companyId, partyId },
      select: { score: true, level: true, metrics: true, computedAt: true, note: true },
      orderBy: { computedAt: 'desc' },
      take: 50,
    });
    return {
      partyId: party.id,
      score: party.score,
      scoreLevel: party.scoreLevel,
      history,
    };
  }
}
