import { ScoreLevel } from '@prisma/client';
import {
  computeScore,
  CustomerScoreService,
  DEFAULT_SCORE_RULES,
  mergeScoreRules,
  SCORE_RULES_SETTING_KEY,
  ScoreMetrics,
  ScoreRules,
} from './customer-score.service';
import { TimelineService } from './timeline.service';

/**
 * p3a-12 — score-rules-from-settings: weights and level thresholds come from
 * the company Setting `crm.score_rules` (defaults when the setting is
 * absent), level boundaries follow the configured thresholds, and a
 * recompute writes CustomerScoreHistory + caches Party.score/scoreLevel.
 */
describe('p3a-12 score-rules-from-settings', () => {
  const COMPANY = 'company-1';

  const fullMetrics = (overrides: Partial<ScoreMetrics> = {}): ScoreMetrics => ({
    operationalProfit: 0,
    tonnage: 0,
    purchaseCount: 0,
    paidAmount: 0,
    recencyDays: 0,
    frequency: 0,
    ...overrides,
  });

  it('absent setting → documented defaults (weights sum to 1, thresholds ordered)', () => {
    const rules = mergeScoreRules(undefined);
    expect(rules).toEqual(DEFAULT_SCORE_RULES);
    const weightSum = Object.values(rules.weights).reduce((a, b) => a + b, 0);
    expect(weightSum).toBeCloseTo(1, 6);
    expect(rules.thresholds.vip).toBeGreaterThan(rules.thresholds.platinum);
    expect(rules.thresholds.platinum).toBeGreaterThan(rules.thresholds.gold);
    expect(rules.thresholds.gold).toBeGreaterThan(rules.thresholds.silver);
  });

  it('crm.score_rules overrides shift level boundaries', () => {
    const weights = { profit: 0, tonnage: 0, purchaseCount: 0, paidAmount: 1.0, recency: 0, frequency: 0 };
    const caps = { paidAmount: 100 };
    // paidAmount 80/100, weight 1.0 → score 800 → VIP under custom thresholds.
    const custom = mergeScoreRules({
      weights,
      caps,
      thresholds: { vip: 800, platinum: 600, gold: 400, silver: 200 },
    });
    expect(computeScore(fullMetrics({ paidAmount: 80 }), custom).level).toBe(ScoreLevel.VIP);
    // Same score under DEFAULT thresholds (vip 900, platinum 750) → PLATINUM:
    // only the thresholds differ, proving they drive the boundaries.
    const defaultThresholds = mergeScoreRules({ weights, caps });
    expect(computeScore(fullMetrics({ paidAmount: 80 }), defaultThresholds).level).toBe(
      ScoreLevel.PLATINUM,
    );
  });

  it('level boundaries are driven by thresholds exactly (descending)', () => {
    const rules: ScoreRules = {
      weights: { profit: 0, tonnage: 0, purchaseCount: 0, paidAmount: 1.0, recency: 0, frequency: 0 },
      thresholds: { vip: 500, platinum: 400, gold: 300, silver: 200 },
      caps: { profit: 0, tonnage: 0, purchaseCount: 0, paidAmount: 1000, recency: 0, frequency: 0 },
    };
    // score = round(1.0 · paid/1000 · 1000) = paid (≤ cap, unclamped).
    const paidFor = (score: number) => score;

    expect(computeScore(fullMetrics({ paidAmount: paidFor(500) }), rules).level).toBe(ScoreLevel.VIP);
    expect(computeScore(fullMetrics({ paidAmount: paidFor(499) }), rules).level).toBe(
      ScoreLevel.PLATINUM,
    );
    expect(computeScore(fullMetrics({ paidAmount: paidFor(300) }), rules).level).toBe(ScoreLevel.GOLD);
    expect(computeScore(fullMetrics({ paidAmount: paidFor(200) }), rules).level).toBe(
      ScoreLevel.SILVER,
    );
    expect(computeScore(fullMetrics({ paidAmount: paidFor(199) }), rules).level).toBe(
      ScoreLevel.BRONZE,
    );
  });

  it('clamps the score to [0, 1000]', () => {
    const huge = mergeScoreRules({
      weights: { profit: 0, tonnage: 0, purchaseCount: 0, paidAmount: 1.0, recency: 0, frequency: 0 },
      caps: { paidAmount: 1 },
    });
    const { score } = computeScore(fullMetrics({ paidAmount: 999_999_999 }), huge);
    expect(score).toBe(1000);
  });

  function makeService(settingValue: unknown, historyRows: unknown[] = []) {
    const history: Record<string, unknown>[] = [];
    const partyUpdates: Record<string, unknown>[] = [];
    const timelineEvents: Record<string, unknown>[] = [];
    const trx = {
      customerScoreHistory: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          history.push(args.data as Record<string, unknown>);
          return args.data;
        }),
      },
      party: {
        update: jest.fn(async (args: { data: Record<string, unknown> }) => {
          partyUpdates.push(args.data as Record<string, unknown>);
          return args.data;
        }),
      },
      timelineEvent: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          timelineEvents.push(args.data as Record<string, unknown>);
          return args.data;
        }),
      },
    };
    const prisma = {
      setting: {
        findUnique: jest.fn(async (args: { where: { companyId_key: { companyId: string; key: string } } }) =>
          args.where.companyId_key.key === SCORE_RULES_SETTING_KEY
            ? { value: settingValue }
            : null,
        ),
      },
      party: {
        findFirst: jest.fn(async () => ({
          id: 'party-1',
          nameFa: 'مشتری نمونه',
          score: null,
          scoreLevel: null,
        })),
      },
      customerScoreHistory: {
        findMany: jest.fn(async () => historyRows),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const service = new CustomerScoreService(
      prisma as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma, history, partyUpdates, timelineEvents };
  }

  it('compute reads crm.score_rules from the company Setting and persists history + cached score', async () => {
    const custom = {
      thresholds: { vip: 100, platinum: 80, gold: 60, silver: 40 },
      weights: { recency: 1.0, profit: 0, tonnage: 0, purchaseCount: 0, paidAmount: 0, frequency: 0 },
    };
    const { service, prisma, history, partyUpdates, timelineEvents } = makeService(custom);

    const result = await service.compute(COMPANY, 'party-1', { id: 'u1', username: 'mgr' });

    expect(prisma.setting.findUnique).toHaveBeenCalledWith({
      where: { companyId_key: { companyId: COMPANY, key: SCORE_RULES_SETTING_KEY } },
      select: { value: true },
    });
    // recencyDays=0 → freshest → weight 1.0 → score 1000 → VIP under custom thresholds.
    expect(result).toMatchObject({ partyId: 'party-1', score: 1000, level: ScoreLevel.VIP });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ companyId: COMPANY, partyId: 'party-1', score: 1000 });
    expect(partyUpdates[0]).toMatchObject({ score: 1000, scoreLevel: ScoreLevel.VIP });
    // Routine event is hidden from the shared timeline (noise control).
    expect(timelineEvents[0]).toMatchObject({ type: 'SCORE_RECOMPUTED', visible: false });
  });

  it('all metrics are 0 until Phase 4/7 data exists (documented placeholder)', async () => {
    const { service } = makeService(undefined);
    const result = await service.compute(COMPANY, 'party-1');
    expect(result.metrics).toEqual({
      operationalProfit: 0,
      tonnage: 0,
      purchaseCount: 0,
      paidAmount: 0,
      recencyDays: 0,
      frequency: 0,
    });
  });

  it('getScore returns cached score/level + history newest-first', async () => {
    const { service } = makeService(undefined, [
      { score: 700, level: ScoreLevel.GOLD, metrics: {}, computedAt: new Date('2026-01-02'), note: null },
      { score: 500, level: ScoreLevel.SILVER, metrics: {}, computedAt: new Date('2026-01-01'), note: null },
    ]);

    const result = await service.getScore(COMPANY, 'party-1');
    expect(result).toMatchObject({ partyId: 'party-1', score: null, scoreLevel: null });
    expect(result.history[0].score).toBe(700); // newest first
    expect(result.history).toHaveLength(2);
  });
});
