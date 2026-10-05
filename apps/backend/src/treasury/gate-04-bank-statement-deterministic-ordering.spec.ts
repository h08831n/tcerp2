import { BankStatementService } from './bank-statement.service';
import {
  describeIntegration,
  disconnectIntegrationPrisma,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  testUuid,
  TEST_INTEGRATION,
} from '../testing/integration';

/**
 * GATE TEST 04 — bank statement deterministic ordering: lines are ordered by
 * (entry_date, sequence_no) and recalcBalances produces correct running
 * balances even after out-of-order inserts (delete + reinsert).
 */
describe('04 bank-statement-deterministic-ordering', () => {
  it('addLine derives the running balance from the previous line (unit)', async () => {
    const created: Record<string, unknown>[] = [];
    let findFirstCalls = 0;
    const trx = {
      $queryRaw: jest.fn().mockResolvedValue([{ seq: 3 }]),
      bankStatementLine: {
        findFirst: jest.fn(() => {
          // 1st call: prev line before the first addLine; later calls see it.
          findFirstCalls += 1;
          return Promise.resolve({ runningBalance: findFirstCalls === 1 ? '100' : '150' });
        }),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async (args: Record<string, unknown>) => {
          created.push(args);
          return args;
        }),
        update: jest.fn(),
      },
    };
    const service = new BankStatementService({} as never);
    const date = new Date(2026, 8, 23);

    await service.addLine(trx as never, {
      companyId: 'c1',
      bankAccountId: 'acc1',
      entryDate: date,
      direction: 'DEPOSIT',
      amount: 50,
    });

    expect(created[0].data).toEqual(
      expect.objectContaining({ sequenceNo: 3, runningBalance: 150, direction: 'DEPOSIT' }),
    );

    await service.addLine(trx as never, {
      companyId: 'c1',
      bankAccountId: 'acc1',
      entryDate: date,
      direction: 'WITHDRAWAL',
      amount: 20,
    });
    expect(created[1].data).toEqual(expect.objectContaining({ runningBalance: 130 }));
  });

  it('recalcBalances fixes running balances deterministically (unit)', async () => {
    const updates: Record<string, unknown>[] = [];
    // Stored rows (in (entry_date, sequence_no) order) with WRONG balances —
    // e.g. after an out-of-order delete + reinsert.
    const trx = {
      bankStatementLine: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([
          { id: 'l1', direction: 'DEPOSIT', amount: '100', runningBalance: '999' },
          { id: 'l2', direction: 'WITHDRAWAL', amount: '30', runningBalance: '1' },
          { id: 'l3', direction: 'DEPOSIT', amount: '10', runningBalance: '-5' },
        ]),
        update: jest.fn(async (args: Record<string, unknown>) => {
          updates.push(args);
          return args;
        }),
      },
    };
    const service = new BankStatementService({} as never);
    await service.recalcBalances(trx as never, 'acc1', new Date(2026, 0, 1));

    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: { id: 'l1' }, data: { runningBalance: 100 } }),
        expect.objectContaining({ where: { id: 'l2' }, data: { runningBalance: 70 } }),
        expect.objectContaining({ where: { id: 'l3' }, data: { runningBalance: 80 } }),
      ]),
    );
  });

  describeIntegration('integration (live DB)', () => {
    const prisma = integrationPrisma();
    let accountId: string;
    let service: BankStatementService;

    beforeAll(() => {
      if (!TEST_INTEGRATION) return;
      service = new BankStatementService(
        prisma as unknown as import('../prisma/prisma.service').PrismaService,
      );
    });

    afterAll(async () => {
      if (!TEST_INTEGRATION) return;
      await prisma.bankStatementLine.deleteMany({ where: { bankAccountId: accountId } });
      await prisma.bankAccount.deleteMany({ where: { id: accountId } });
      await disconnectIntegrationPrisma();
    });

    it('inserts out of order, recalculates, and lists deterministically', async () => {
      const account = await prisma.bankAccount.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          name: `stmt-test-${testUuid().slice(0, 8)}`,
          bankName: 'Test Bank',
        },
      });
      accountId = account.id;
      const day = new Date(Date.UTC(2026, 8, 23));
      const day2 = new Date(Date.UTC(2026, 8, 24));

      // Insert WITH WRONG running balances and OUT of (date, seq) order.
      await prisma.bankStatementLine.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          bankAccountId: accountId,
          entryDate: day2,
          sequenceNo: 1,
          direction: 'DEPOSIT',
          amount: 40,
          runningBalance: 0, // wrong
        },
      });
      await prisma.bankStatementLine.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          bankAccountId: accountId,
          entryDate: day,
          sequenceNo: 2,
          direction: 'DEPOSIT',
          amount: 100,
          runningBalance: 123, // wrong
        },
      });
      await prisma.bankStatementLine.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          bankAccountId: accountId,
          entryDate: day,
          sequenceNo: 1,
          direction: 'DEPOSIT',
          amount: 50,
          runningBalance: -7, // wrong
        },
      });

      await prisma.$transaction(async (trx) => {
        await service.recalcBalances(trx, accountId, day);
      });

      const lines = await service.list(accountId);
      expect(lines.map((l) => [l.entryDate.toISOString().slice(0, 10), l.sequenceNo])).toEqual([
        ['2026-09-23', 1],
        ['2026-09-23', 2],
        ['2026-09-24', 1],
      ]);
      expect(lines.map((l) => Number(l.runningBalance))).toEqual([50, 150, 190]);
    });
  });
});
