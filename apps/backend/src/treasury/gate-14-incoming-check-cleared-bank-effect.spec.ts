import { ValidationError } from '../common/errors';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { ChecksService } from './checks.service';
import { BankTransferService } from './bank-transfer.service';

/**
 * GATE TEST 14 — incoming check lifecycle: registering changes nothing in the
 * bank statement or journal; CLEARED posts exactly one DEPOSIT statement line
 * plus one posted, balanced journal (Dr BANK / Cr CHECKS_IN_TRANSIT);
 * DEPOSITED and BOUNCED create no statement line.
 */
describe('14 incoming-check-cleared-bank-effect', () => {
  const COMPANY = 'company-1';

  const ACCOUNTS = [
    { id: 'acc-bank', code: 'BANK' },
    { id: 'acc-cit', code: 'CHECKS_IN_TRANSIT' },
  ];
  const CODE_BY_ID: Record<string, string> = { 'acc-bank': 'BANK', 'acc-cit': 'CHECKS_IN_TRANSIT' };

  function makeMocks(claimRow?: unknown) {
    const createdChecks: Record<string, unknown>[] = [];
    const checkUpdates: Record<string, unknown>[] = [];
    const createdEntries: Record<string, unknown>[] = [];
    const createdLines: Record<string, unknown>[] = [];

    const sequences = { allocate: jest.fn().mockResolvedValue({ number: 'JE-1405-00001', value: 1 }) };
    const journal = new JournalService({} as never, sequences as never);
    const statement = new BankStatementService({} as never);
    const audit = { record: jest.fn() };

    const checkCreate = jest.fn(async (args: { data: object }) => {
      createdChecks.push(args as unknown as Record<string, unknown>);
      return { id: 'chk-1', ...args.data, status: 'REGISTERED' };
    });
    const checkFindUnique = jest.fn(async () => claimRow ?? { id: 'chk-1', companyId: COMPANY, direction: 'INCOMING', status: 'DEPOSITED', amount: '700', checkNumber: 'C-100' });
    const checkUpdate = jest.fn(async (args: Record<string, unknown>) => {
      checkUpdates.push(args);
      return { id: 'chk-1', status: 'CLEARED', ...(args.data as object) };
    });

    const trx = {
      $queryRaw: jest.fn().mockResolvedValue([{ seq: 1 }]),
      chartOfAccount: { findMany: jest.fn().mockResolvedValue(ACCOUNTS) },
      journalEntry: {
        create: jest.fn(async (args: Record<string, unknown>) => {
          createdEntries.push(args);
          return { id: 'je-1', entryNumber: 'JE-1405-00001', lines: [] };
        }),
        update: jest.fn(async () => ({ id: 'je-1', entryNumber: 'JE-1', status: 'POSTED', lines: [] })),
      },
      check: { create: checkCreate, findUnique: checkFindUnique, update: checkUpdate },
      bankStatementLine: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(async (args: Record<string, unknown>) => {
          createdLines.push(args);
          return args;
        }),
        update: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
      check: { create: checkCreate, findUnique: checkFindUnique, update: checkUpdate },
      bankAccount: {
        findUnique: jest.fn(async (args: { where: { id: string } }) =>
          args.where.id === 'bank-1' ? { id: 'bank-1', companyId: COMPANY, name: 'Melli' } : null,
        ),
      },
    };

    const transfers = new BankTransferService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
    );
    const service = new ChecksService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
      transfers as never,
    );
    return { service, trx, createdChecks, checkUpdates, createdEntries, createdLines, prisma, journal, audit };
  }

  it('registering an incoming check has NO journal or statement effect', async () => {
    const { service, createdChecks, createdEntries, createdLines } = makeMocks();
    const actor = { id: 'u1', username: 'accountant' };

    const check = await service.register(
      COMPANY,
      'INCOMING',
      { checkNumber: 'C-100', amount: 700, dueDate: new Date(2026, 9, 1) },
      actor,
      {},
    );

    expect(check.status).toBe('REGISTERED');
    expect(createdChecks).toHaveLength(1);
    expect(createdEntries).toHaveLength(0); // no journal
    expect(createdLines).toHaveLength(0); // no statement line
  });

  it('CLEARED posts exactly one DEPOSIT line and one balanced posted journal', async () => {
    const { service, checkUpdates, createdEntries, createdLines, trx } = makeMocks();
    const actor = { id: 'u1', username: 'accountant' };

    const cleared = await service.transition(
      COMPANY,
      'chk-1',
      'CLEARED',
      { bankAccountId: 'bank-1', actor, ctx: {} },
    );

    expect(cleared.status).toBe('CLEARED');
    expect(createdLines).toHaveLength(1);
    expect(createdLines[0].data).toEqual(
      expect.objectContaining({
        bankAccountId: 'bank-1',
        direction: 'DEPOSIT',
        amount: 700,
        sourceEntityType: 'CHECK',
      }),
    );
    expect(createdEntries).toHaveLength(1);
    const rawLines = (createdEntries[0].data as { lines: { create: Record<string, unknown>[] } }).lines.create;
    const lines: Record<string, unknown>[] = rawLines.map((l) => ({ ...l, accountCode: CODE_BY_ID[l.accountId as string] }));
    expect(lines).toHaveLength(2);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'BANK', debit: 700, credit: 0 }),
        expect.objectContaining({ accountCode: 'CHECKS_IN_TRANSIT', debit: 0, credit: 700 }),
      ]),
    );
    const sumDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const sumCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(sumDebit).toBe(sumCredit);
    expect(trx.journalEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'POSTED' }) }),
    );
    expect(checkUpdates[0].data).toEqual(expect.objectContaining({ status: 'CLEARED' }));
  });

  it('DEPOSITED and BOUNCED create no statement line', async () => {
    const { service, createdLines, prisma } = makeMocks();
    const actor = { id: 'u1', username: 'accountant' };
    // Stateful row: REGISTERED → PENDING → DEPOSITED → BOUNCED.
    const row = { id: 'chk-1', companyId: COMPANY, direction: 'INCOMING', status: 'REGISTERED', amount: '700', checkNumber: 'C-100' };
    (prisma.check.findUnique as jest.Mock).mockImplementation(async () => ({ ...row }));

    await service.transition(COMPANY, 'chk-1', 'PENDING', { actor, ctx: {} });
    row.status = 'PENDING';
    await service.transition(COMPANY, 'chk-1', 'DEPOSITED', { actor, ctx: {} });
    row.status = 'DEPOSITED';
    expect(createdLines).toHaveLength(0);

    await service.transition(COMPANY, 'chk-1', 'BOUNCED', { actor, ctx: {} });
    expect(createdLines).toHaveLength(0); // bounced: still no bank effect
  });

  it('invalid transitions throw: incoming CLEARED→PAID, DEPOSITED→CLEARED without bank account', async () => {
    const { service } = makeMocks({ ...mockClearedCheck() });
    // Incoming CLEARED → PAID is never valid (also PAID is outgoing-only).
    await expect(
      service.transition(COMPANY, 'chk-1', 'PAID', { bankAccountId: 'bank-1' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('CLEARED without a bank account is rejected', async () => {
    const { service } = makeMocks();
    await expect(
      service.transition(COMPANY, 'chk-1', 'CLEARED', {}),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  function mockClearedCheck() {
    return {
      id: 'chk-1',
      companyId: COMPANY,
      direction: 'INCOMING',
      status: 'CLEARED',
      amount: '700',
      checkNumber: 'C-100',
    };
  }
});
