import { Injectable } from '@nestjs/common';
import { BankLineDirection, Check, CheckDirection, CheckStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SequencesService } from '../sequences/sequences.service';
import { JournalService } from '../accounting/journal.service';
import { BankStatementService } from './bank-statement.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { BankTransferService } from './bank-transfer.service';

export interface RegisterCheckInput {
  checkNumber: string;
  partyId?: string | null;
  amount: number;
  dueDate: Date;
  issueDate?: Date;
  bankName?: string;
  description?: string;
}

/**
 * Check lifecycle (REQUIREMENTS correction gate):
 *   incoming: REGISTERED → PENDING → DEPOSITED → CLEARED | BOUNCED | CANCELLED
 *   outgoing: REGISTERED → PENDING → PAID | BOUNCED | CANCELLED
 *
 * Registering has NO accounting effect. The single bank effect happens at:
 *   incoming CLEARED → Dr BANK / Cr CHECKS_IN_TRANSIT + DEPOSIT statement line
 *   outgoing PAID    → Dr CHECKS_IN_TRANSIT / Cr BANK + WITHDRAWAL statement line
 * (Journal convention documented here: at register nothing is posted; the
 * CHECKS_IN_TRANSIT pair balances across the two lifecycle events.)
 */
const INCOMING_TRANSITIONS: Record<CheckStatus, CheckStatus[]> = {
  REGISTERED: ['PENDING', 'CANCELLED'],
  PENDING: ['DEPOSITED', 'BOUNCED', 'CANCELLED'],
  DEPOSITED: ['CLEARED', 'BOUNCED', 'CANCELLED'],
  CLEARED: [],
  PAID: [],
  BOUNCED: [],
  CANCELLED: [],
};

const OUTGOING_TRANSITIONS: Record<CheckStatus, CheckStatus[]> = {
  REGISTERED: ['PENDING', 'CANCELLED'],
  PENDING: ['PAID', 'BOUNCED', 'CANCELLED'],
  DEPOSITED: [],
  CLEARED: [],
  PAID: [],
  BOUNCED: [],
  CANCELLED: [],
};

@Injectable()
export class ChecksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sequences: SequencesService,
    private readonly journal: JournalService,
    private readonly statement: BankStatementService,
    private readonly auditService: AuditService,
    private readonly transfers: BankTransferService,
  ) {}

  async getById(companyId: string, id: string): Promise<Check> {
    const check = await this.prisma.check.findUnique({ where: { id } });
    if (!check || check.companyId !== companyId) {
      throw new NotFoundError('Check not found', { id });
    }
    return check;
  }

  /** Registering a check must NOT touch journal or bank statement. */
  async register(
    companyId: string,
    direction: CheckDirection,
    input: RegisterCheckInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Check> {
    const amount = Number(input.amount);
    if (!(amount > 0)) throw new ValidationError('Check amount must be positive', { amount });

    const check = await this.prisma.check.create({
      data: {
        companyId,
        direction,
        checkNumber: input.checkNumber,
        partyId: input.partyId ?? null,
        bankName: input.bankName,
        amount,
        issueDate: input.issueDate,
        dueDate: input.dueDate,
        status: 'REGISTERED',
        description: input.description,
        createdBy: actor.id,
      },
    });
    await this.auditService.record({
      entityType: 'check',
      entityId: check.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { direction, checkNumber: input.checkNumber, amount, status: 'REGISTERED' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    // No journal entry, no statement line — by design.
    return check;
  }

  /** Generic transition with direction-aware validation. */
  async transition(
    companyId: string,
    id: string,
    to: CheckStatus,
    opts: { bankAccountId?: string; actor?: { id: string; username: string }; ctx?: RequestContext },
  ): Promise<Check> {
    const check = await this.getById(companyId, id);
    const allowed =
      check.direction === 'INCOMING' ? INCOMING_TRANSITIONS[check.status] : OUTGOING_TRANSITIONS[check.status];
    if (!allowed.includes(to)) {
      throw new ValidationError(`Invalid check transition ${check.status} → ${to}`, {
        direction: check.direction,
        from: check.status,
        to,
      });
    }

    if (to === 'CLEARED') return this.applyIncomingCleared(check, opts);
    if (to === 'PAID') return this.applyOutgoingPaid(check, opts);

    const updated = await this.prisma.check.update({
      where: { id: check.id },
      data: { status: to },
    });
    if (opts.actor) {
      await this.auditService.record({
        entityType: 'check',
        entityId: check.id,
        action: AuditAction.UPDATE,
        actor: opts.actor,
        companyId,
        oldValues: { status: check.status },
        newValues: { status: to },
        ip: opts.ctx?.ip,
        userAgent: opts.ctx?.userAgent,
      });
    }
    return updated;
  }

  /** Incoming CLEARED — requires a bank account; posts bank effect. */
  async applyIncomingCleared(
    check: Check,
    opts: { bankAccountId?: string; actor?: { id: string; username: string }; ctx?: RequestContext },
  ): Promise<Check> {
    if (!opts.bankAccountId) {
      throw new ValidationError('A bank account is required to clear an incoming check');
    }
    const bankAccount = await this.transfers.assertAccount(check.companyId, opts.bankAccountId);
    const amount = Number(check.amount);

    return this.prisma.$transaction(async (trx) => {
      const entry = await this.journal.post(trx, {
        companyId: check.companyId,
        entryDate: new Date(),
        journalCode: 'TREASURY',
        documentType: 'CHECK_CLEAR',
        description: `Incoming check ${check.checkNumber} cleared`,
        createdBy: opts.actor?.id,
        lines: [
          { accountCode: 'BANK', debit: amount, credit: 0 },
          { accountCode: 'CHECKS_IN_TRANSIT', debit: 0, credit: amount },
        ],
      });
      await this.statement.addLine(trx, {
        companyId: check.companyId,
        bankAccountId: bankAccount.id,
        entryDate: new Date(),
        direction: BankLineDirection.DEPOSIT,
        amount,
        description: `Incoming check ${check.checkNumber}`,
        sourceEntityType: 'CHECK',
        sourceEntityId: check.id,
        journalEntryId: entry.id,
      });
      const updated = await trx.check.update({
        where: { id: check.id },
        data: { status: 'CLEARED', bankAccountId: bankAccount.id, journalEntryId: entry.id },
      });
      if (opts.actor) {
        await this.auditService.record({
          entityType: 'check',
          entityId: check.id,
          action: AuditAction.UPDATE,
          actor: opts.actor,
          companyId: check.companyId,
          oldValues: { status: check.status },
          newValues: { status: 'CLEARED', entryNumber: entry.entryNumber },
          ip: opts.ctx?.ip,
          userAgent: opts.ctx?.userAgent,
        });
      }
      return updated;
    });
  }

  /** Outgoing PAID — requires a bank account; posts bank effect. */
  async applyOutgoingPaid(
    check: Check,
    opts: { bankAccountId?: string; actor?: { id: string; username: string }; ctx?: RequestContext },
  ): Promise<Check> {
    if (!opts.bankAccountId) {
      throw new ValidationError('A bank account is required to pay an outgoing check');
    }
    const bankAccount = await this.transfers.assertAccount(check.companyId, opts.bankAccountId);
    const amount = Number(check.amount);

    return this.prisma.$transaction(async (trx) => {
      const entry = await this.journal.post(trx, {
        companyId: check.companyId,
        entryDate: new Date(),
        journalCode: 'TREASURY',
        documentType: 'CHECK_PAY',
        description: `Outgoing check ${check.checkNumber} paid`,
        createdBy: opts.actor?.id,
        lines: [
          { accountCode: 'CHECKS_IN_TRANSIT', debit: amount, credit: 0 },
          { accountCode: 'BANK', debit: 0, credit: amount },
        ],
      });
      await this.statement.addLine(trx, {
        companyId: check.companyId,
        bankAccountId: bankAccount.id,
        entryDate: new Date(),
        direction: BankLineDirection.WITHDRAWAL,
        amount,
        description: `Outgoing check ${check.checkNumber}`,
        sourceEntityType: 'CHECK',
        sourceEntityId: check.id,
        journalEntryId: entry.id,
      });
      const updated = await trx.check.update({
        where: { id: check.id },
        data: { status: 'PAID', bankAccountId: bankAccount.id, journalEntryId: entry.id },
      });
      if (opts.actor) {
        await this.auditService.record({
          entityType: 'check',
          entityId: check.id,
          action: AuditAction.UPDATE,
          actor: opts.actor,
          companyId: check.companyId,
          oldValues: { status: check.status },
          newValues: { status: 'PAID', entryNumber: entry.entryNumber },
          ip: opts.ctx?.ip,
          userAgent: opts.ctx?.userAgent,
        });
      }
      return updated;
    });
  }

  async list(companyId: string, filter?: { status?: CheckStatus; direction?: CheckDirection }) {
    return this.prisma.check.findMany({
      where: { companyId, status: filter?.status, direction: filter?.direction },
      orderBy: { dueDate: 'asc' },
    });
  }
}
