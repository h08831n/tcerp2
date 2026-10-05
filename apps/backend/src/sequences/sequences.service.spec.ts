import { Prisma } from '@prisma/client';
import { formatSequence, SequencesService, shouldResetYearly } from './sequences.service';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'seq-1',
    code: 'SALES_DOCUMENT',
    name: 'Sales document',
    prefix: 'SD',
    padding: 5,
    includeJalaliYear: true,
    resetYearly: true,
    currentNumber: 0,
    lastResetYear: null as number | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('formatSequence', () => {
  const date = new Date(2026, 3, 5); // 2026-04-05 → Jalali 1405

  it('formats with the Jalali year: SD-1405-00125', () => {
    const config = makeConfig();
    expect(formatSequence(config, 125, date)).toBe('SD-1405-00125');
  });

  it('omits the year when includeJalaliYear is false', () => {
    const config = makeConfig({ includeJalaliYear: false });
    expect(formatSequence(config, 7, date)).toBe('SD-00007');
  });

  it('pads to the configured width', () => {
    const config = makeConfig({ padding: 3, includeJalaliYear: false });
    expect(formatSequence(config, 42, date)).toBe('SD-042');
  });
});

describe('shouldResetYearly', () => {
  const date = new Date(2026, 3, 5); // Jalali year 1405

  it('resets when resetYearly and the stored year differs', () => {
    expect(shouldResetYearly(makeConfig({ resetYearly: true, lastResetYear: 1404 }), date)).toBe(true);
  });

  it('resets when resetYearly and no year stored yet', () => {
    expect(shouldResetYearly(makeConfig({ resetYearly: true, lastResetYear: null }), date)).toBe(true);
  });

  it('does not reset within the same year', () => {
    expect(shouldResetYearly(makeConfig({ resetYearly: true, lastResetYear: 1405 }), date)).toBe(false);
  });

  it('never resets when resetYearly is false', () => {
    expect(shouldResetYearly(makeConfig({ resetYearly: false, lastResetYear: 1400 }), date)).toBe(false);
  });
});

describe('SequencesService.allocate', () => {
  const date = new Date(2026, 3, 5); // Jalali 1405

  function makePrismaMock(config: ReturnType<typeof makeConfig>) {
    const findUniqueOrThrow = jest.fn().mockResolvedValue(config);
    const update = jest.fn(async (_args: unknown) => ({ ...config }));
    const queryRaw = jest.fn().mockResolvedValue([
      { current_number: config.currentNumber, last_reset_year: config.lastResetYear },
    ]);
    const trx = { $queryRaw: queryRaw, sequence: { findUniqueOrThrow, update } };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    return { prisma, trx, findUniqueOrThrow, update, queryRaw };
  }

  function makeService(prismaMock: ReturnType<typeof makePrismaMock>['prisma']): SequencesService {
    return new SequencesService(prismaMock as never, { record: jest.fn() } as never);
  }

  it('increments the counter and returns the formatted number', async () => {
    const config = makeConfig({ currentNumber: 124, includeJalaliYear: true, resetYearly: false });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('SALES_DOCUMENT', undefined, date);

    expect(result).toEqual({ number: 'SD-1405-00125', value: 125 });
    expect(mock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { code: 'SALES_DOCUMENT' },
        data: expect.objectContaining({ currentNumber: 125 }),
      }),
    );
  });

  it('resets to 1 at the start of a new Jalali year and stores the year', async () => {
    const config = makeConfig({ currentNumber: 9000, resetYearly: true, lastResetYear: 1404 });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('SALES_DOCUMENT', undefined, date);

    expect(result).toEqual({ number: 'SD-1405-00001', value: 1 });
    expect(mock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentNumber: 1, lastResetYear: 1405 }),
      }),
    );
  });

  it('does not reset mid-year and preserves lastResetYear when resetYearly is false', async () => {
    const config = makeConfig({ currentNumber: 10, resetYearly: false, lastResetYear: null });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('SALES_DOCUMENT', undefined, date);

    expect(result).toEqual({ number: 'SD-1405-00011', value: 11 });
    expect(mock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentNumber: 11, lastResetYear: null }),
      }),
    );
  });

  it('runs inside a caller-supplied transaction without opening a new one', async () => {
    const config = makeConfig({ currentNumber: 0, resetYearly: false });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const trx = { $queryRaw: mock.queryRaw, sequence: { findUniqueOrThrow: mock.findUniqueOrThrow, update: mock.update } } as unknown as Prisma.TransactionClient;

    await service.allocate('SALES_DOCUMENT', trx, date);

    expect(mock.prisma.$transaction).not.toHaveBeenCalled();
  });
});
