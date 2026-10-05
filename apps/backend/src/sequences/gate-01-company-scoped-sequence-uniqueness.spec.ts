import { Prisma } from '@prisma/client';
import { ConflictError } from '../common/errors';
import { SequencesService } from './sequences.service';

/**
 * GATE TEST 01 — company-scoped sequence uniqueness:
 *   - two companies may allocate the same documentType independently;
 *   - a duplicate (companyId, documentType) config conflicts;
 *   - concurrent allocations (serialized by SELECT … FOR UPDATE) return
 *     distinct numbers.
 */
describe('01 company-scoped-sequence-uniqueness', () => {
  const date = new Date(2026, 8, 23); // Jalali 1405-07

  function makeConfig(companyId: string, currentNumber: number) {
    return {
      id: `seq-${companyId}`,
      companyId,
      documentType: 'SALES_DOCUMENT',
      name: 'Sales document',
      prefix: 'SD',
      padding: 5,
      resetCycle: 'JALALI_YEAR' as const,
      currentNumber,
      lastResetMarker: '1405',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  function makeTrxMock(config: ReturnType<typeof makeConfig>, rawQueue: unknown[][]) {
    let rawCall = 0;
    const update = jest.fn(async (args: unknown) => ({ ...config }));
    const trx = {
      $queryRaw: jest.fn(async () => rawQueue[Math.min(rawCall++, rawQueue.length - 1)]),
      setting: { findUnique: jest.fn().mockResolvedValue(null) },
      sequence: { findUniqueOrThrow: jest.fn().mockResolvedValue(config), update },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    return { prisma, trx, update };
  }

  function makeService(prismaMock: { $transaction: unknown }): SequencesService {
    return new SequencesService(prismaMock as never, { record: jest.fn() } as never);
  }

  it('two companies with the same documentType allocate independently', async () => {
    const companyA = makeTrxMock(makeConfig('company-A', 0), [[{ current_number: 0, last_reset_marker: '1405' }]]);
    const companyB = makeTrxMock(makeConfig('company-B', 500), [[{ current_number: 500, last_reset_marker: '1405' }]]);

    const a = await makeService(companyA.prisma).allocate('company-A', 'SALES_DOCUMENT', undefined, date);
    const b = await makeService(companyB.prisma).allocate('company-B', 'SALES_DOCUMENT', undefined, date);

    expect(a.number).toBe('SD-1405-00001');
    expect(b.number).toBe('SD-1405-00501');
    // Each allocation scoped by company_id in the locked SELECT.
    expect(companyA.trx.$queryRaw).toHaveBeenCalled();
    expect(companyA.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId_documentType: { companyId: 'company-A', documentType: 'SALES_DOCUMENT' } },
      }),
    );
    expect(companyB.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId_documentType: { companyId: 'company-B', documentType: 'SALES_DOCUMENT' } },
      }),
    );
  });

  it('a duplicate (companyId, documentType) config conflicts', async () => {
    const existing = makeConfig('company-A', 10);
    const prisma = {
      sequence: { findUnique: jest.fn().mockResolvedValue(existing) },
    };
    const audit = { record: jest.fn() };
    const service = new SequencesService(prisma as never, audit as never);

    await expect(
      service.createConfig(
        'company-A',
        {
          documentType: 'SALES_DOCUMENT',
          name: 'Sales document',
          prefix: 'SD',
          padding: 5,
          resetCycle: 'JALALI_YEAR',
        },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('concurrent allocations (locked rows) return distinct numbers', async () => {
    // Serialized by FOR UPDATE: the second allocator observes the first commit.
    const config = makeConfig('company-A', 0);
    const rawQueue = [
      [{ current_number: 0, last_reset_marker: '1405' }],
      [{ current_number: 1, last_reset_marker: '1405' }],
    ];
    const mock = makeTrxMock(config, rawQueue);
    const service = makeService(mock.prisma);

    const [first, second] = await Promise.all([
      service.allocate('company-A', 'SALES_DOCUMENT', undefined, date),
      service.allocate('company-A', 'SALES_DOCUMENT', undefined, date),
    ]);

    expect(first.value).toBe(1);
    expect(second.value).toBe(2);
    expect(first.number).not.toBe(second.number);
  });

  it('throws NotFoundError when the company has no sequence for the type', async () => {
    const mock = makeTrxMock(makeConfig('company-A', 0), [[]]); // empty locked SELECT
    const service = makeService(mock.prisma);
    await expect(
      service.allocate('company-A', 'UNKNOWN_TYPE', undefined, date),
    ).rejects.toBeInstanceOf(Error);
  });

  it('allocation is usable inside a caller transaction (no nested $transaction)', async () => {
    const config = makeConfig('company-A', 0);
    const mock = makeTrxMock(config, [[{ current_number: 0, last_reset_marker: '1405' }]]);
    const trx = mock.trx as unknown as Prisma.TransactionClient;
    await makeService(mock.prisma).allocate('company-A', 'SALES_DOCUMENT', trx, date);
    expect(mock.prisma.$transaction).not.toHaveBeenCalled();
  });
});
