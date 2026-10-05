import { Injectable } from '@nestjs/common';
import { BankAccount, BankLineDirection, BankTransfer, JournalEntry } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

export interface CreateTransferInput {
  sourceBankAccountId: string;
  destinationBankAccountId: string;
  amount: number;
  fee?: number;
  transferDate?: Date;
  description?: string;
}

/**
 * Bank transfer X with fee F posts exactly:
 *   Dr Destination BANK X  ·  Dr BANK_FEE_EXPENSE F  ·  Cr Source BANK X+F
 *   Statement lines: source WITHDRAWAL X+F, destination DEPOSIT X.
 * Journal entry + transfer row + both statement lines are one transaction.
 */
@Injectable()
export class BankTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly journal: JournalService,
    private readonly statement: BankStatementService,
    private readonly auditService: AuditService,
  ) {}

  async assertAccount(companyId: string, id: string): Promise<BankAccount> {
    const account = await this.prisma.bankAccount.findUnique({ where: { id } });
    if (!account || account.companyId !== companyId) {
      throw new NotFoundError('Bank account not found', { id });
    }
    return account;
  }

  async createTransfer(
    companyId: string,
    input: CreateTransferInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<BankTransfer & { journalEntry?: JournalEntry }> {
    const amount = Number(input.amount);
    const fee = Number(input.fee ?? 0);
    if (!(amount > 0)) throw new ValidationError('Transfer amount must be positive', { amount });
    if (fee < 0) throw new ValidationError('Transfer fee cannot be negative', { fee });
    if (input.sourceBankAccountId === input.destinationBankAccountId) {
      throw new ValidationError('Source and destination bank accounts must differ');
    }

    const source = await this.assertAccount(companyId, input.sourceBankAccountId);
    const destination = await this.assertAccount(companyId, input.destinationBankAccountId);
    const transferDate = input.transferDate ?? new Date();

    return this.prisma.$transaction(async (trx) => {
      const { number: transferNumber } = await this.sequences.allocate(
        companyId,
        'BANK_TRANSFER',
        trx,
        transferDate,
      );

      const transfer = await trx.bankTransfer.create({
        data: {
          companyId,
          transferNumber,
          sourceBankAccountId: source.id,
          destinationBankAccountId: destination.id,
          amount,
          fee,
          transferDate,
          description: input.description,
          createdBy: actor.id,
        },
      });

      const journalLines = [
        { accountCode: 'BANK', debit: amount, credit: 0, description: `Transfer to ${destination.name}` },
        ...(fee > 0
          ? [{ accountCode: 'BANK_FEE_EXPENSE', debit: fee, credit: 0, description: 'Transfer fee' }]
          : []),
        { accountCode: 'BANK', debit: 0, credit: amount + fee, description: `Transfer from ${source.name}` },
      ];
      const entry = await this.journal.post(trx, {
        companyId,
        entryDate: transferDate,
        journalCode: 'TREASURY',
        documentType: 'BANK_TRANSFER',
        description: input.description ?? `Bank transfer ${transferNumber}`,
        createdBy: actor.id,
        lines: journalLines,
      });

      await this.statement.addLine(trx, {
        companyId,
        bankAccountId: source.id,
        entryDate: transferDate,
        direction: BankLineDirection.WITHDRAWAL,
        amount: amount + fee,
        description: input.description ?? `Bank transfer ${transferNumber}`,
        sourceEntityType: 'BANK_TRANSFER',
        sourceEntityId: transfer.id,
        journalEntryId: entry.id,
      });
      await this.statement.addLine(trx, {
        companyId,
        bankAccountId: destination.id,
        entryDate: transferDate,
        direction: BankLineDirection.DEPOSIT,
        amount,
        description: input.description ?? `Bank transfer ${transferNumber}`,
        sourceEntityType: 'BANK_TRANSFER',
        sourceEntityId: transfer.id,
        journalEntryId: entry.id,
      });

      const saved = await trx.bankTransfer.update({
        where: { id: transfer.id },
        data: { journalEntryId: entry.id },
        include: { sourceBankAccount: true, destinationBankAccount: true },
      });

      await this.auditService.record({
        entityType: 'bank_transfer',
        entityId: transfer.id,
        action: AuditAction.CREATE,
        actor,
        companyId,
        newValues: { transferNumber, amount, fee, entryNumber: entry.entryNumber },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return saved as BankTransfer;
    });
  }
}
