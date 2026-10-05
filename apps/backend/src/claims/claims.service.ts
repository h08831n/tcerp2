import { Injectable } from '@nestjs/common';
import { OperationalSettlementClaim } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { PartyOperationalBalanceService } from './party-balance.service';
import { NotificationService, RecipientConfig } from '../notifications/notifications.service';
import { NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

export interface CreateClaimInput {
  direction: 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT';
  partyId: string;
  salesDocumentId?: string;
  purchaseDocumentId?: string;
  amount: number;
  notes?: string;
}

export interface MatchClaimInput {
  receiptId?: string;
  paymentId?: string;
}

/**
 * Operational settlement claims (REQUIREMENTS correction gate).
 * Direction semantics (also enforced by the DB CHECK):
 *   CUSTOMER_RECEIPT → requires salesDocumentId, purchaseDocumentId forbidden
 *   SUPPLIER_PAYMENT → requires purchaseDocumentId, salesDocumentId forbidden
 * The balance effect of an UNMATCHED claim is temporary; REJECTED restores it.
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balance: PartyOperationalBalanceService,
    private readonly auditService: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  /** Service-level mirror of the claims_direction_document CHECK. */
  static assertDirectionSemantics(input: CreateClaimInput): void {
    const amount = Number(input.amount);
    if (!(amount > 0)) {
      throw new ValidationError('Claim amount must be positive', { amount });
    }
    if (input.direction === 'CUSTOMER_RECEIPT') {
      if (!input.salesDocumentId) {
        throw new ValidationError('A customer receipt claim requires a sales document');
      }
      if (input.purchaseDocumentId) {
        throw new ValidationError('A customer receipt claim cannot reference a purchase document');
      }
    } else if (input.direction === 'SUPPLIER_PAYMENT') {
      if (!input.purchaseDocumentId) {
        throw new ValidationError('A supplier payment claim requires a purchase document');
      }
      if (input.salesDocumentId) {
        throw new ValidationError('A supplier payment claim cannot reference a sales document');
      }
    } else {
      throw new ValidationError('Unknown claim direction', { direction: input.direction });
    }
  }

  async create(
    companyId: string,
    input: CreateClaimInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<OperationalSettlementClaim> {
    ClaimsService.assertDirectionSemantics(input);
    const amount = Number(input.amount);

    return this.prisma.$transaction(async (trx) => {
      const claim = await trx.operationalSettlementClaim.create({
        data: {
          companyId,
          direction: input.direction,
          partyId: input.partyId,
          salesDocumentId: input.salesDocumentId,
          purchaseDocumentId: input.purchaseDocumentId,
          amount,
          status: 'UNMATCHED',
          declaredBy: actor.id,
        },
      });
      await this.balance.applyDelta(
        trx,
        companyId,
        input.partyId,
        PartyOperationalBalanceService.deltaFor(input.direction, amount),
      );
      return claim;
    });
  }

  async createAndAudit(
    companyId: string,
    input: CreateClaimInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<OperationalSettlementClaim> {
    const claim = await this.create(companyId, input, actor, ctx);
    await this.auditService.record({
      entityType: 'claim',
      entityId: claim.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: {
        direction: claim.direction,
        partyId: claim.partyId,
        amount: Number(claim.amount),
        status: claim.status,
        notes: input.notes,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return claim;
  }

  async getById(companyId: string, id: string): Promise<OperationalSettlementClaim> {
    const claim = await this.prisma.operationalSettlementClaim.findUnique({ where: { id } });
    if (!claim || claim.companyId !== companyId) {
      throw new NotFoundError('Claim not found', { id });
    }
    return claim;
  }

  async list(
    companyId: string,
    filter?: { status?: 'UNMATCHED' | 'MATCHED' | 'REJECTED'; partyId?: string },
  ): Promise<OperationalSettlementClaim[]> {
    return this.prisma.operationalSettlementClaim.findMany({
      where: { companyId, status: filter?.status, partyId: filter?.partyId },
      orderBy: { declaredAt: 'desc' },
    });
  }

  /**
   * Reject an UNMATCHED claim: restore the balance delta, store the reason,
   * audit (CLAIM_REJECTED doubles as the claim timeline event) and notify the
   * declaring user through the `payment.rejected` rules when any exist.
   */
  async reject(
    companyId: string,
    id: string,
    reason: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<OperationalSettlementClaim> {
    if (!reason || reason.trim().length === 0) {
      throw new ValidationError('A rejection reason is required');
    }

    const claim = await this.prisma.$transaction(async (trx) => {
      const existing = await trx.operationalSettlementClaim.findUnique({ where: { id } });
      if (!existing || existing.companyId !== companyId) {
        throw new NotFoundError('Claim not found', { id });
      }
      if (existing.status !== 'UNMATCHED') {
        throw new ValidationError('Only UNMATCHED claims can be rejected', { status: existing.status });
      }
      const delta = PartyOperationalBalanceService.deltaFor(
        existing.direction as 'CUSTOMER_RECEIPT' | 'SUPPLIER_PAYMENT',
        Number(existing.amount),
      );
      await this.balance.applyDelta(trx, companyId, existing.partyId, -delta);
      return trx.operationalSettlementClaim.update({
        where: { id: existing.id },
        data: { status: 'REJECTED', rejectionReason: reason },
      });
    });

    // Audit = claim timeline event (entityType 'claim').
    await this.auditService.record({
      entityType: 'claim',
      entityId: claim.id,
      action: 'CLAIM_REJECTED',
      actor,
      companyId,
      oldValues: { status: 'UNMATCHED' },
      newValues: { status: 'REJECTED', rejectionReason: reason },
      reason,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    // Notify the declaring user via notification_rules (event payment.rejected)
    // when rules exist and match; otherwise a direct IN_APP notification.
    const payload = {
      claimDirection: claim.direction,
      claimId: claim.id,
      partyId: claim.partyId,
      amount: Number(claim.amount),
      rejectionReason: reason,
    };
    const dispatched = await this.notifications.dispatchRulesForEvent('payment.rejected', payload, {
      companyId,
      title: 'ثبت تسویه رد شد',
      body: reason,
      relatedEntityType: 'claim',
      relatedEntityId: claim.id,
      priority: 'HIGH',
    });
    if (dispatched === 0 && claim.declaredBy) {
      await this.notifications.createNotifications([claim.declaredBy], {
        companyId,
        title: 'ثبت تسویه رد شد',
        body: reason,
        relatedEntityType: 'claim',
        relatedEntityId: claim.id,
        priority: 'HIGH',
      });
    }

    return claim;
  }

  /**
   * Match an UNMATCHED claim to a treasury document. The balance effect is
   * kept — matching confirms it in accounting.
   */
  async match(
    companyId: string,
    id: string,
    input: MatchClaimInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<OperationalSettlementClaim> {
    const claim = await this.prisma.$transaction(async (trx) => {
      const existing = await trx.operationalSettlementClaim.findUnique({ where: { id } });
      if (!existing || existing.companyId !== companyId) {
        throw new NotFoundError('Claim not found', { id });
      }
      if (existing.status !== 'UNMATCHED') {
        throw new ValidationError('Only UNMATCHED claims can be matched', { status: existing.status });
      }
      if (existing.direction === 'CUSTOMER_RECEIPT' && !input.receiptId) {
        throw new ValidationError('A customer receipt claim must match to a receipt');
      }
      if (existing.direction === 'SUPPLIER_PAYMENT' && !input.paymentId) {
        throw new ValidationError('A supplier payment claim must match to a payment');
      }
      return trx.operationalSettlementClaim.update({
        where: { id: existing.id },
        data: {
          status: 'MATCHED',
          matchedReceiptId: input.receiptId,
          matchedPaymentId: input.paymentId,
        },
      });
    });

    await this.auditService.record({
      entityType: 'claim',
      entityId: claim.id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: { status: 'UNMATCHED' },
      newValues: {
        status: 'MATCHED',
        matchedReceiptId: input.receiptId,
        matchedPaymentId: input.paymentId,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return claim;
  }
}
