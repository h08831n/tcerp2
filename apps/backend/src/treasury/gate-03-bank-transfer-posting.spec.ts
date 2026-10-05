import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { BankTransferService } from './bank-transfer.service';

/**
 * GATE TEST 03 — bank transfer posting. For amount X with fee F the posted
 * journal is exactly: Dr destination BANK X, Dr BANK_FEE_EXPENSE F,
 * Cr source BANK X+F (balanced), and the statement gets two lines:
 * source WITHDRAWAL X+F and destination DEPOSIT X. Zero fee → no fee line.
 */
describe('03 bank-transfer-posting', () => {
  const COMPANY = 'company-1';
  const transferDate = new Date(2026, 8, 23);
  const ACCOUNTS = [
    { id: 'acc-bank', code: 'BANK' },
    { id: 'acc-fee', code: 'BANK_FEE_EXPENSE' },
  ];

  function makeMocks() {
    const createdEntries: Record<string, unknown>[] = [];
    const createdLines: Record<string, unknown>[] = [];
    const seqAllocate = jest.fn().mockResolvedValue({
      companyId: COMPANY,
      documentType: 'BANK_TRANSFER',
      number: 'BT-1405-00001',
      value: 1,
    });
    const sequences = { allocate: seqAllocate };
    const journal = new JournalService({} as never, sequences as never);
    const statement = new BankStatementService({} as never);
    const audit = { record: jest.fn() };

    const trx = {
      $queryRaw: jest.fn().mockResolvedValue([{ seq: 1 }]),
      chartOfAccount: { findMany: jest.fn().mockResolvedValue(ACCOUNTS) },
      journalEntry: {
        create: jest.fn(async (args: Record<string, unknown>) => {
          createdEntries.push(args);
          return { id: 'je-1', entryNumber: 'JE-1405-00001', lines: [] };
        }),
        update: jest.fn(async () => ({
          id: 'je-1',
          entryNumber: 'JE-1405-00001',
          status: 'POSTED',
          lines: [],
        })),
      },
      bankTransfer: {
        create: jest.fn(async () => ({ id: 'bt-1' })),
        update: jest.fn(async () => ({ id: 'bt-1', journalEntryId: 'je-1' })),
      },
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
      bankAccount: {
        findUnique: jest.fn(async (args: { where: { id: string } }) =>
          args.where.id === 'src' || args.where.id === 'dst'
            ? { id: args.where.id, companyId: COMPANY, name: args.where.id }
            : null,
        ),
      },
    };

    const service = new BankTransferService(
      prisma as never,
      sequences as never,
      journal as never,
      statement as never,
      audit as never,
    );
    return { service, trx, createdEntries, createdLines, prisma, audit };
  }

  const CODE_BY_ID: Record<string, string> = { 'acc-bank': 'BANK', 'acc-fee': 'BANK_FEE_EXPENSE' };

  function entryLines(createdEntries: Record<string, unknown>[]): Record<string, unknown>[] {
    const lines = (createdEntries[0].data as { lines: { create: Record<string, unknown>[] } }).lines.create;
    return lines.map((l) => ({ ...l, accountCode: CODE_BY_ID[l.accountId as string] }));
  }

  it('posts Dr dest X / Dr fee F / Cr source X+F and two statement lines', async () => {
    const { service, createdEntries, createdLines, trx } = makeMocks();

    await service.createTransfer(
      COMPANY,
      {
        sourceBankAccountId: 'src',
        destinationBankAccountId: 'dst',
        amount: 1000,
        fee: 25,
        transferDate,
      },
      { id: 'u1', username: 'admin' },
      {},
    );

    // Journal: exactly three lines, balanced.
    const lines = entryLines(createdEntries);
    expect(lines).toHaveLength(3);
    const sumDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const sumCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(sumDebit).toBe(1025);
    expect(sumCredit).toBe(1025);
    // Dr destination X
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'BANK', debit: 1000, credit: 0 }),
      ]),
    );
    // Dr BANK_FEE_EXPENSE F
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'BANK_FEE_EXPENSE', debit: 25, credit: 0 }),
      ]),
    );
    // Cr source X+F
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ accountCode: 'BANK', debit: 0, credit: 1025 }),
      ]),
    );

    // Statement: exactly two lines — source WITHDRAWAL X+F, destination DEPOSIT X.
    expect(createdLines).toHaveLength(2);
    expect(createdLines[0].data).toEqual(
      expect.objectContaining({
        bankAccountId: 'src',
        direction: 'WITHDRAWAL',
        amount: 1025,
        sourceEntityType: 'BANK_TRANSFER',
      }),
    );
    expect(createdLines[1].data).toEqual(
      expect.objectContaining({
        bankAccountId: 'dst',
        direction: 'DEPOSIT',
        amount: 1000,
        sourceEntityType: 'BANK_TRANSFER',
      }),
    );
    expect(trx.journalEntry.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'POSTED' }) }),
    );
  });

  it('zero fee → two journal lines only (no fee line), still balanced', async () => {
    const { service, createdEntries, createdLines } = makeMocks();

    await service.createTransfer(
      COMPANY,
      {
        sourceBankAccountId: 'src',
        destinationBankAccountId: 'dst',
        amount: 500,
        transferDate,
      },
      { id: 'u1', username: 'admin' },
      {},
    );

    const lines = entryLines(createdEntries);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.accountCode)).toEqual(['BANK', 'BANK']);
    const sumDebit = lines.reduce((s, l) => s + Number(l.debit), 0);
    const sumCredit = lines.reduce((s, l) => s + Number(l.credit), 0);
    expect(sumDebit).toBe(500);
    expect(sumCredit).toBe(500);
    expect(createdLines).toHaveLength(2);
  });

  it('rejects same source/destination and non-positive amounts', async () => {
    const { service } = makeMocks();
    await expect(
      service.createTransfer(
        COMPANY,
        { sourceBankAccountId: 'src', destinationBankAccountId: 'src', amount: 100 },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    await expect(
      service.createTransfer(
        COMPANY,
        { sourceBankAccountId: 'src', destinationBankAccountId: 'dst', amount: 0 },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});
