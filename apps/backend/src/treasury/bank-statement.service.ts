import { Injectable } from '@nestjs/common';
import { BankLineDirection, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationError } from '../common/errors';

type Tx = Prisma.TransactionClient;

export interface AddStatementLineInput {
  companyId: string;
  bankAccountId: string;
  entryDate: Date;
  direction: BankLineDirection;
  amount: number;
  referenceNumber?: string;
  description?: string;
  sourceEntityType?: string;
  sourceEntityId?: string;
  journalEntryId?: string;
}

function toDay(date: Date): Date {
  // BankStatementLine.entryDate is a @db.Date — normalize to UTC midnight of
  // the same calendar day so ordering/comparisons are deterministic.
  return new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
}

/**
 * BankStatementLine is a non-source ledger: a deterministic (entry_date,
 * sequence_no) projection of treasury documents with running balances.
 * Ordering per (bank_account_id, entry_date) is allocated with a locked
 * MAX(sequence_no)+1 query so concurrent writers on the same day cannot clash.
 */
@Injectable()
export class BankStatementService {
  constructor(private readonly prisma: PrismaService) {}

  /** Per-account per-day sequence allocation under a row lock. */
  static async nextSequenceNo(
    tx: Tx,
    bankAccountId: string,
    day: Date,
  ): Promise<number> {
    const rows = await tx.$queryRaw<{ seq: number }[]>`
      SELECT COALESCE(MAX("sequence_no"), 0) + 1 AS "seq"
      FROM (
        SELECT "sequence_no" FROM "bank_statement_lines"
        WHERE "bank_account_id" = ${bankAccountId}::uuid AND "entry_date" = ${day.toISOString().slice(0, 10)}::date
        FOR UPDATE
      ) locked
    `;
    return Number(rows[0].seq);
  }

  /**
   * Append one statement line inside `tx`: allocates the per-day sequence,
   * derives the running balance from the account's previous line, and
   * recalculates any subsequent lines (deterministic re-ordering safety).
   */
  async addLine(tx: Tx, input: AddStatementLineInput) {
    if (!(input.amount > 0)) {
      throw new ValidationError('Statement line amount must be positive', { amount: input.amount });
    }
    const day = toDay(input.entryDate);

    const seq = await BankStatementService.nextSequenceNo(tx, input.bankAccountId, day);
    const previous = await tx.bankStatementLine.findFirst({
      where: { bankAccountId: input.bankAccountId, entryDate: { lte: day } },
      orderBy: [{ entryDate: 'desc' }, { sequenceNo: 'desc' }],
      select: { runningBalance: true },
    });
    const prevBalance = previous ? Number(previous.runningBalance) : 0;
    const runningBalance =
      input.direction === 'DEPOSIT'
        ? prevBalance + input.amount
        : prevBalance - input.amount;

    const line = await tx.bankStatementLine.create({
      data: {
        companyId: input.companyId,
        bankAccountId: input.bankAccountId,
        entryDate: day,
        sequenceNo: seq,
        direction: input.direction,
        amount: input.amount,
        runningBalance,
        referenceNumber: input.referenceNumber,
        description: input.description,
        sourceEntityType: input.sourceEntityType,
        sourceEntityId: input.sourceEntityId,
        journalEntryId: input.journalEntryId,
      },
    });

    await this.recalcBalances(tx, input.bankAccountId, day);
    return line;
  }

  /** Deterministic running-balance recalculation from `fromDate` onward. */
  async recalcBalances(
    tx: Tx,
    bankAccountId: string,
    fromDate: Date,
  ): Promise<void> {
    const day = toDay(fromDate);
    const before = await tx.bankStatementLine.findFirst({
      where: { bankAccountId, entryDate: { lt: day } },
      orderBy: [{ entryDate: 'desc' }, { sequenceNo: 'desc' }],
      select: { runningBalance: true },
    });
    let balance = before ? Number(before.runningBalance) : 0;

    const lines = await tx.bankStatementLine.findMany({
      where: { bankAccountId, entryDate: { gte: day } },
      orderBy: [{ entryDate: 'asc' }, { sequenceNo: 'asc' }],
    });
    for (const line of lines) {
      const amount = Number(line.amount);
      balance = line.direction === 'DEPOSIT' ? balance + amount : balance - amount;
      if (Number(line.runningBalance) !== balance) {
        await tx.bankStatementLine.update({
          where: { id: line.id },
          data: { runningBalance: balance },
        });
      }
    }
  }

  async list(accountId: string, from?: Date, to?: Date) {
    return this.prisma.bankStatementLine.findMany({
      where: {
        bankAccountId: accountId,
        ...(from || to
          ? { entryDate: { ...(from ? { gte: toDay(from) } : {}), ...(to ? { lte: toDay(to) } : {}) } }
          : {}),
      },
      orderBy: [{ entryDate: 'asc' }, { sequenceNo: 'asc' }],
    });
  }
}
