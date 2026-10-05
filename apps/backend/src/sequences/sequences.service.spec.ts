import { Prisma } from '@prisma/client';
import {
  computeResetMarker,
  formatSequence,
  SequencesService,
} from './sequences.service';

function makeConfig(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'seq-1',
    companyId: 'c-1',
    documentType: 'SALES_DOCUMENT',
    name: 'Sales document',
    prefix: 'SD',
    padding: 5,
    resetCycle: 'JALALI_YEAR' as const,
    currentNumber: 0,
    lastResetMarker: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('formatSequence', () => {
  it('formats with the Jalali year marker: SD-1405-00001', () => {
    const config = makeConfig();
    expect(formatSequence(config, 1, '1405')).toBe('SD-1405-00001');
  });

  it('compacts the monthly marker: SD-140507-00012', () => {
    const config = makeConfig();
    expect(formatSequence(config, 12, '1405-07')).toBe('SD-140507-00012');
  });

  it('omits the marker segment for NEVER', () => {
    const config = makeConfig();
    expect(formatSequence(config, 7, null)).toBe('SD-00007');
  });

  it('pads to the configured width', () => {
    const config = makeConfig({ padding: 3 });
    expect(formatSequence(config, 42, '1405')).toBe('SD-1405-042');
  });
});

describe('computeResetMarker', () => {
  const date = new Date(2026, 8, 23); // 2026-09-23 → Jalali 1405-07-01

  it('JALALI_YEAR → the Jalali year', () => {
    expect(computeResetMarker('JALALI_YEAR', date, '01-01')).toBe('1405');
  });

  it('MONTHLY → jalali year-month', () => {
    expect(computeResetMarker('MONTHLY', date, '01-01')).toBe('1405-07');
  });

  it('FISCAL_YEAR → FY marker honoring the fiscal start setting', () => {
    expect(computeResetMarker('FISCAL_YEAR', date, '01-01')).toBe('FY-2026');
    expect(computeResetMarker('FISCAL_YEAR', new Date(2026, 0, 10), '04-01')).toBe('FY-2025');
  });

  it('NEVER → null', () => {
    expect(computeResetMarker('NEVER', date, '01-01')).toBeNull();
  });
});

describe('SequencesService.allocate', () => {
  const date = new Date(2026, 8, 23); // Jalali 1405-07

  function makePrismaMock(config: ReturnType<typeof makeConfig>) {
    const findUniqueOrThrow = jest.fn().mockResolvedValue(config);
    const update = jest.fn(async (_args: unknown) => ({ ...config }));
    const settingFindUnique = jest.fn().mockResolvedValue(null);
    const queryRaw = jest.fn().mockResolvedValue([
      { current_number: config.currentNumber, last_reset_marker: config.lastResetMarker },
    ]);
    const trx = {
      $queryRaw: queryRaw,
      setting: { findUnique: settingFindUnique },
      sequence: { findUniqueOrThrow, update },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    return { prisma, trx, findUniqueOrThrow, update, queryRaw, settingFindUnique };
  }

  function makeService(prismaMock: ReturnType<typeof makePrismaMock>['prisma']): SequencesService {
    return new SequencesService(prismaMock as never, { record: jest.fn() } as never);
  }

  it('increments the counter and returns the formatted number', async () => {
    const config = makeConfig({ currentNumber: 124, lastResetMarker: '1405' });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('c-1', 'SALES_DOCUMENT', undefined, date);

    expect(result.number).toBe('SD-1405-00125');
    expect(result.value).toBe(125);
    expect(mock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId_documentType: { companyId: 'c-1', documentType: 'SALES_DOCUMENT' } },
        data: expect.objectContaining({ currentNumber: 125 }),
      }),
    );
  });

  it('resets to 1 when the JALALI_YEAR marker changes', async () => {
    const config = makeConfig({ currentNumber: 9000, lastResetMarker: '1404' });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('c-1', 'SALES_DOCUMENT', undefined, date);

    expect(result.number).toBe('SD-1405-00001');
    expect(result.value).toBe(1);
    expect(mock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentNumber: 1, lastResetMarker: '1405' }),
      }),
    );
  });

  it('does not reset within the same month for MONTHLY', async () => {
    const config = makeConfig({
      resetCycle: 'MONTHLY',
      currentNumber: 10,
      lastResetMarker: '1405-07',
    });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('c-1', 'SALES_DOCUMENT', undefined, date);

    expect(result.number).toBe('SD-140507-00011');
    expect(result.value).toBe(11);
  });

  it('never resets for NEVER (marker null)', async () => {
    const config = makeConfig({ resetCycle: 'NEVER', currentNumber: 41, lastResetMarker: null });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const result = await service.allocate('c-1', 'SALES_DOCUMENT', undefined, date);

    expect(result.number).toBe('SD-00042');
    expect(mock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentNumber: 42, lastResetMarker: null }),
      }),
    );
  });

  it('uses the fiscal year start setting for FISCAL_YEAR markers', async () => {
    const config = makeConfig({
      resetCycle: 'FISCAL_YEAR',
      currentNumber: 9000,
      lastResetMarker: 'FY-2024',
    });
    const mock = makePrismaMock(config);
    mock.settingFindUnique.mockResolvedValue({ value: '04-01' });
    const service = makeService(mock.prisma);

    const result = await service.allocate('c-1', 'SALES_DOCUMENT', undefined, new Date(2026, 0, 10));

    expect(result.number).toBe('SD-FY2025-00001');
  });

  it('runs inside a caller-supplied transaction without opening a new one', async () => {
    const config = makeConfig({ currentNumber: 0, lastResetMarker: '1405' });
    const mock = makePrismaMock(config);
    const service = makeService(mock.prisma);

    const trx = {
      $queryRaw: mock.queryRaw,
      setting: { findUnique: mock.settingFindUnique },
      sequence: { findUniqueOrThrow: mock.findUniqueOrThrow, update: mock.update },
    } as unknown as Prisma.TransactionClient;

    await service.allocate('c-1', 'SALES_DOCUMENT', trx, date);

    expect(mock.prisma.$transaction).not.toHaveBeenCalled();
  });
});
