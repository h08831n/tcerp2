import { Injectable } from '@nestjs/common';
import { BankLineDirection, Payment, Receipt } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { BankTransferService } from './bank-transfer.service';

export interface CreateTreasuryDocInput {
  bankAccountId: string;
  partyId?: string | null;
  amount: number;
  date?: Date;
  description?: string;
}

/**
 * Receipts (money in): Dr BANK / Cr RECEIVABLE + DEPOSIT statement line.
 */
@Injectable()
export class ReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly journal: JournalService,
    private readonly statement: BankStatementService,
    private readonly auditService: AuditService,
    private readonly transfers: BankTransferService,
  ) {}

  async create(
    companyId: string,
    input: CreateTreasuryDocInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Receipt> {
    const amount = Number(input.amount);
    if (!(amount > 0)) throw new ValidationError('Receipt amount must be positive', { amount });
    const account = await this.transfers.assertAccount(companyId, input.bankAccountId);
    const date = input.date ?? new Date();

    return this.prisma.$transaction(async (trx) => {
      const { number: receiptNumber } = await this.sequences.allocate(
        companyId,
        'RECEIPT',
        trx,
        date,
      );

      const receipt = await trx.receipt.create({
        data: {
          companyId,
          receiptNumber,
          bankAccountId: account.id,
          partyId: input.partyId ?? null,
          amount,
          receiptDate: date,
          description: input.description,
          createdBy: actor.id,
        },
      });

      const entry = await this.journal.post(trx, {
        companyId,
        entryDate: date,
        journalCode: 'TREASURY',
        documentType: 'RECEIPT',
        description: input.description ?? `Receipt ${receiptNumber}`,
        createdBy: actor.id,
        lines: [
          { accountCode: 'BANK', debit: amount, credit: 0, partyId: input.partyId ?? undefined },
          { accountCode: 'RECEIVABLE', debit: 0, credit: amount, partyId: input.partyId ?? undefined },
        ],
      });

      await this.statement.addLine(trx, {
        companyId,
        bankAccountId: account.id,
        entryDate: date,
        direction: BankLineDirection.DEPOSIT,
        amount,
        description: input.description ?? `Receipt ${receiptNumber}`,
        sourceEntityType: 'RECEIPT',
        sourceEntityId: receipt.id,
        journalEntryId: entry.id,
      });

      const saved = await trx.receipt.update({
        where: { id: receipt.id },
        data: { journalEntryId: entry.id },
      });

      await this.auditService.record({
        entityType: 'receipt',
        entityId: receipt.id,
        action: AuditAction.CREATE,
        actor,
        companyId,
        newValues: { receiptNumber, amount, entryNumber: entry.entryNumber },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return saved;
    });
  }
}

/**
 * Payments (money out): Dr PAYABLE / Cr BANK + WITHDRAWAL statement line.
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly journal: JournalService,
    private readonly statement: BankStatementService,
    private readonly auditService: AuditService,
    private readonly transfers: BankTransferService,
  ) {}

  async create(
    companyId: string,
    input: CreateTreasuryDocInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Payment> {
    const amount = Number(input.amount);
    if (!(amount > 0)) throw new ValidationError('Payment amount must be positive', { amount });
    const account = await this.transfers.assertAccount(companyId, input.bankAccountId);
    const date = input.date ?? new Date();

    return this.prisma.$transaction(async (trx) => {
      const { number: paymentNumber } = await this.sequences.allocate(
        companyId,
        'PAYMENT',
        trx,
        date,
      );

      const payment = await trx.payment.create({
        data: {
          companyId,
          paymentNumber,
          bankAccountId: account.id,
          partyId: input.partyId ?? null,
          amount,
          paymentDate: date,
          description: input.description,
          createdBy: actor.id,
        },
      });

      const entry = await this.journal.post(trx, {
        companyId,
        entryDate: date,
        journalCode: 'TREASURY',
        documentType: 'PAYMENT',
        description: input.description ?? `Payment ${paymentNumber}`,
        createdBy: actor.id,
        lines: [
          { accountCode: 'PAYABLE', debit: amount, credit: 0, partyId: input.partyId ?? undefined },
          { accountCode: 'BANK', debit: 0, credit: amount, partyId: input.partyId ?? undefined },
        ],
      });

      await this.statement.addLine(trx, {
        companyId,
        bankAccountId: account.id,
        entryDate: date,
        direction: BankLineDirection.WITHDRAWAL,
        amount,
        description: input.description ?? `Payment ${paymentNumber}`,
        sourceEntityType: 'PAYMENT',
        sourceEntityId: payment.id,
        journalEntryId: entry.id,
      });

      const saved = await trx.payment.update({
        where: { id: payment.id },
        data: { journalEntryId: entry.id },
      });

      await this.auditService.record({
        entityType: 'payment',
        entityId: payment.id,
        action: AuditAction.CREATE,
        actor,
        companyId,
        newValues: { paymentNumber, amount, entryNumber: entry.entryNumber },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return saved;
    });
  }
}
