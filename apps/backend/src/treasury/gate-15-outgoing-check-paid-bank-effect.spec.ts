import { ValidationError } from '../common/errors';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { ChecksService } from './checks.service';
import { BankTransferService } from './bank-transfer.service';

/**
 * GATE TEST 15 — outgoing check lifecycle: registering has no bank effect;
 * PAID posts exactly one WITHDRAWAL statement line plus one balanced journal
 * (Dr CHECKS_IN_TRANSIT / Cr BANK); an incoming check can never be PAID.
 */
describe('15 outgoing-check-paid-bank-effect', () => {
  const COMPANY = 'company-1';
  const ACCOUNTS = [
    { id: 'acc-bank', code: 'BANK' },
    { id: 'acc-cit', code: 'CHECKS_IN_TRANSIT' },
  ];
  const CODE_BY_ID: Record<string, string> = { 'acc-bank': 'BANK', 'acc-cit': 'CHECKS_IN_TRANSIT' };

  function makeMocks(checkRow: unknown) {
    const createdChecks: Record<string, unknown>[] = [];
    const createdEntries: Record<string, unknown>[] = [];
    const createdLines: Record<string, unknown>[] = [];

    const sequences = { allocate: jest.fn().mockResolvedValue({ number: 'JE-1405-00001', value: 1 }) };
    const journal = new JournalService({} as never, sequences as never);
    const statement = new BankStatementService({} as never);
    const audit = { record: jest.fn() };

    const checkUpdates: Record<string, unknown>[] = [];
    const checkCreate = jest.fn(async (args: { data: object }) => {
      createdChecks.push(args as unknown as Record<string, unknown>);
      return { id: 'chk-2', ...args.data, status: 'REGISTERED' };
    });
    const checkFindUnique = jest.fn(async () => checkRow);
    const checkUpdate = jest.fn(async (args: Record<string, unknown>) => {
      checkUpdates.push(args);
      return { id: 'chk-2', status: 'PAID', ...(args.data as object) };
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
          args.where.id === 'bank-2' ? { id: 'bank-2', companyId: COMPANY, name: 'Saderat' } : null,
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
    return { service, createdChecks, createdEntries, createdLines, checkUpdates, prisma, trx };
  }

  it('registering an outgoing check has NO journal or statement effect', async () => {
    const { service, createdChecks, createdEntries, createdLines } = makeMocks(null);
    const check = await service.register(
      COMPANY,
      'OUTGOING',
      { checkNumber: 'C-200', amount: 450, dueDate: new Date(2026, 9, 15) },
      { id: 'u1', username: 'accountant' },
      {},
    );
    expect(check.status).toBe('REGISTERED');
    expect(createdChecks).toHaveLength(1);
    expect(createdEntries).toHaveLength(0);
    expect(createdLines).toHaveLength(0);
  });

  it('PAID posts exactly one WITHDRAWAL line and one balanced posted journal', async () => {
    const { service, createdEntries, createdLines, trx } = makeMocks({
      id: 'chk-2',
      companyId: COMPANY,
      direction: 'OUTGOING',
      status: 'PENDING',
      amount: '450',
      checkNumber: 'C-200',
    });

    const paid = await service.transition(COMPANY, 'chk-2', 'PAID', {
      bankAccountId: 'bank-2',
      actor: { id: 'u1', username: 'accountant' },
      ctx: {},
    });

    expect(paid.status).toBe('PAID');
    expect(createdLines).toHaveLength(1);
    expect(createdLines[0].data).toEqual(
      expect.objectContaining({
        bankAccountId: 'bank-2',
        direction: 'WITHDRAWAL',
        amount: 450,
        sourceEntityType: 'CHECK',
      }),
    );
    expect(createdEntries).toHaveLength(1);
    const rawLines = (createdEntries[0].data as { lines: { create: Record<string, unknown>[] } }).lines.create;
    const lines: Record<string, unknown>[] = rawLines.map((l) => ({ ...l, accountCode: CODE_BY_ID[l.accountId as string] }));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'CHECKS_IN_TRANSIT', debit: 450, credit: 0 }),
        expect.objectContaining({ accountCode: 'BANK', debit: 0, credit: 450 }),
      ]),
    );
    const sumDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const sumCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(sumDebit).toBe(sumCredit);
    expect(trx.journalEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'POSTED' }) }),
    );
  });

  it('an incoming check cannot be PAID', async () => {
    const { service, createdEntries, createdLines } = makeMocks({
      id: 'chk-3',
      companyId: COMPANY,
      direction: 'INCOMING',
      status: 'PENDING',
      amount: '100',
      checkNumber: 'C-300',
    });
    await expect(
      service.transition(COMPANY, 'chk-3', 'PAID', { bankAccountId: 'bank-2' }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(createdEntries).toHaveLength(0);
    expect(createdLines).toHaveLength(0);
  });

  it('an outgoing check cannot be CLEARED (incoming-only status)', async () => {
    const { service } = makeMocks({
      id: 'chk-2',
      companyId: COMPANY,
      direction: 'OUTGOING',
      status: 'PENDING',
      amount: '450',
      checkNumber: 'C-200',
    });
    await expect(
      service.transition(COMPANY, 'chk-2', 'CLEARED', { bankAccountId: 'bank-2' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('PAID without a bank account is rejected', async () => {
    const { service, createdEntries, createdLines } = makeMocks({
      id: 'chk-2',
      companyId: COMPANY,
      direction: 'OUTGOING',
      status: 'PENDING',
      amount: '450',
      checkNumber: 'C-200',
    });
    await expect(service.transition(COMPANY, 'chk-2', 'PAID', {})).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(createdEntries).toHaveLength(0);
    expect(createdLines).toHaveLength(0);
  });
});
