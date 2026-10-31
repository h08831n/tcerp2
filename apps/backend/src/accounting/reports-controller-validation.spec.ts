import { ReportsController } from './reports.controller';
import { ValidationError } from '../common/errors';

/**
 * P1-6 (review of 80502ae): report query params are validated at the
 * controller boundary BEFORE any service/Prisma call — unparseable dates,
 * reversed windows, level values and asOf/to combinations are rejected with
 * typed 400s; valid params reach the service parsed. Controller-level unit
 * tests with stubbed services (no DB).
 */
describe('reports controller parameter validation', () => {
  let controller: ReportsController;
  const calls: { gl: unknown[]; tb: unknown[]; profit: unknown[] } = { gl: [], tb: [], profit: [] };

  const ACTOR = { id: 'u1', username: 'admin' };
  const REQ = { headers: {} } as never;

  beforeAll(() => {
    controller = new ReportsController(
      { generalLedger: async (...args: unknown[]) => { calls.gl.push(args); return { ok: true }; },
        trialBalance: async (...args: unknown[]) => { calls.tb.push(args); return { ok: true }; },
        journalEntry: async () => ({}) } as never,
      { operationalProfit: async (...args: unknown[]) => { calls.profit.push(args); return { ok: true }; } } as never,
      { valuation: async () => ({}) } as never,
      { partyLedger: async () => ({}) } as never,
      { stage: async () => ({}), generate: async () => ({}), assertStagedBalanced: () => undefined } as never,
      { requireCompanyId: async () => 'c1' } as never,
    );
  });

  it('rejects an unparseable date with REPORT_DATE_INVALID (GL)', async () => {
    await expect(
      controller.generalLedger('BANK', 'not-a-date', undefined, undefined, undefined, undefined, undefined, undefined, undefined, ACTOR, REQ),
    ).rejects.toThrow('REPORT_DATE_INVALID');
    expect(calls.gl).toHaveLength(0);
  });

  it('rejects a reversed window with REPORT_RANGE_REVERSED (GL)', async () => {
    await expect(
      controller.generalLedger('BANK', '2026-03-01', '2026-01-01', undefined, undefined, undefined, undefined, undefined, undefined, ACTOR, REQ),
    ).rejects.toThrow('REPORT_RANGE_REVERSED');
  });

  it('rejects garbage dates and reversed windows on trial-balance', async () => {
    await expect(
      controller.trialBalance('garbage', undefined, undefined, undefined, ACTOR, REQ),
    ).rejects.toThrow('REPORT_DATE_INVALID');
    await expect(
      controller.trialBalance('2026-05-01', '2026-01-01', undefined, undefined, ACTOR, REQ),
    ).rejects.toThrow('REPORT_RANGE_REVERSED');
    await expect(
      controller.trialBalance(undefined, '2026-01-01', '2026-02-01', undefined, ACTOR, REQ),
    ).rejects.toThrow('TRIAL_BALANCE_ASOF_TO_CONFLICT');
    await expect(
      controller.trialBalance(undefined, undefined, undefined, 'wrong', ACTOR, REQ),
    ).rejects.toThrow('TRIAL_BALANCE_LEVEL_INVALID');
    expect(calls.tb).toHaveLength(0);
  });

  it('accepts a valid window and forwards parsed dates (BUG-10 contract)', async () => {
    await controller.trialBalance('2026-01-01', '2026-03-31', undefined, 'leaf', ACTOR, REQ);
    const [companyIdArg, optsArg] = calls.tb[0] as [string, { from: Date; to: Date; level: string }];
    expect(companyIdArg).toBe('c1');
    expect(optsArg.from.toISOString().slice(0, 10)).toBe('2026-01-01');
    expect(optsArg.to.toISOString().slice(0, 10)).toBe('2026-03-31');
    expect(optsArg.level).toBe('leaf');
  });

  it('forwards supplierId to the profit service (BUG-11 contract)', async () => {
    await controller.operationalProfit('2026-01-01', '2026-02-01', undefined, 'sup-1', undefined, undefined, ACTOR, REQ);
    const [, optsArg] = calls.profit[0] as [string, { supplierId?: string; from: Date }];
    expect(optsArg.supplierId).toBe('sup-1');
    expect(optsArg.from.toISOString().slice(0, 10)).toBe('2026-01-01');
  });

  it('rejects reversed windows on operational-profit', async () => {
    await expect(
      controller.operationalProfit('2026-02-01', '2026-01-01', undefined, undefined, undefined, undefined, ACTOR, REQ),
    ).rejects.toThrow('REPORT_RANGE_REVERSED');
  });
});
