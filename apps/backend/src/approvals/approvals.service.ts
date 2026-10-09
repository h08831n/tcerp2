import { Injectable } from '@nestjs/common';
import { ApprovalRequest, ApprovalStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from '../parties/timeline.service';
import { NotificationService } from '../notifications/notifications.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { ApprovalQueryDto } from './approvals.dto';

export const APPROVAL_MESSAGES = {
  alreadyDecided: 'APPROVAL_ALREADY_DECIDED',
} as const;

/**
 * Lean approval engine (Phase 6, REQUIREMENTS §51 subset + domain boundaries
 * "Debt gate"): single-decision requests, currently used by the Loading debt
 * gate (`RELEASE_DRIVER_INFO`). One PENDING request → one decision (APPROVED |
 * REJECTED); re-deciding is a 409. Every decision is audited atomically and
 * the requester is notified.
 *
 * Loading-specific effect: an APPROVED `RELEASE_DRIVER_INFO` decision clears
 * `loadings.driver_info_restricted` in the SAME transaction (a REJECTED
 * decision leaves the restriction in place). This is done here — through
 * Prisma directly, without importing LoadingModule — so the generic decide
 * endpoint and the loading release endpoint share one implementation.
 */
@Injectable()
export class ApprovalRequestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
    private readonly notifications: NotificationService,
  ) {}

  async list(companyId: string, query: ApprovalQueryDto): Promise<Paginated<ApprovalRequest>> {
    const where: Prisma.ApprovalRequestWhereInput = {
      companyId,
      status: query.status,
      approvalType: query.approvalType,
      entityType: query.entityType,
    };
    const [items, total] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.approvalRequest.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(companyId: string, id: string): Promise<ApprovalRequest> {
    const approval = await this.prisma.approvalRequest.findUnique({ where: { id } });
    if (!approval || approval.companyId !== companyId) {
      throw new NotFoundError('Approval request not found', { id });
    }
    return approval;
  }

  /** The PENDING release request for a loading, if any. */
  async findPendingLoadingRelease(
    companyId: string,
    loadingId: string,
  ): Promise<ApprovalRequest | null> {
    return this.prisma.approvalRequest.findFirst({
      where: {
        companyId,
        entityType: 'loading',
        entityId: loadingId,
        approvalType: 'RELEASE_DRIVER_INFO',
        status: ApprovalStatus.PENDING,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Decide a PENDING request (APPROVED | REJECTED). Atomic: decision + audit
   * (+ the loading driver-info release + its timeline event) commit together;
   * the requester notification follows the commit (best effort — a failed
   * notification never un-decides an approval).
   */
  async decide(
    companyId: string,
    id: string,
    input: { decision: 'APPROVED' | 'REJECTED'; note?: string },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<ApprovalRequest> {
    const existing = await this.getById(companyId, id);
    if (existing.status !== ApprovalStatus.PENDING) {
      throw new ConflictError(APPROVAL_MESSAGES.alreadyDecided, {
        id,
        status: existing.status,
      });
    }

    const decision = await this.prisma.$transaction(async (tx) => {
      const approval = await tx.approvalRequest.update({
        where: { id: existing.id },
        data: {
          status: input.decision,
          decidedBy: actor.id,
          decidedAt: new Date(),
          decisionNote: input.note,
          approverId: actor.id,
        },
      });

      // Loading debt-gate effect: APPROVED releases the restricted driver /
      // carrier info (REJECTED keeps it restricted — nothing to do).
      if (
        approval.entityType === 'loading' &&
        approval.approvalType === 'RELEASE_DRIVER_INFO' &&
        input.decision === 'APPROVED'
      ) {
        const loading = await tx.loading.update({
          where: { id: approval.entityId },
          data: { driverInfoRestricted: false },
          select: { id: true, customerPartyId: true },
        });
        if (loading.customerPartyId) {
          await this.timeline.record(tx, {
            companyId,
            entityType: 'PARTY',
            entityId: loading.customerPartyId,
            type: 'DRIVER_INFO_RELEASED',
            title: 'انتشار اطلاعات راننده',
            description: 'اطلاعات راننده/باربری با تایید مدیر منتشر شد',
            data: { loadingId: loading.id, approvalId: approval.id },
            actorUserId: actor.id,
          });
        }
      }

      await this.auditService.recordTx(tx, {
        entityType: 'approval_request',
        entityId: approval.id,
        action: input.decision === 'APPROVED' ? 'APPROVAL_APPROVED' : 'APPROVAL_REJECTED',
        companyId,
        actor,
        oldValues: { status: existing.status },
        newValues: { status: approval.status, entityType: approval.entityType, approvalType: approval.approvalType },
        reason: input.note,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return approval;
    });

    if (decision.requestedBy) {
      await this.notifications.createNotifications([decision.requestedBy], {
        companyId,
        title: input.decision === 'APPROVED' ? 'تایید درخواست' : 'رد درخواست',
        body:
          input.decision === 'APPROVED'
            ? `درخواست ${decision.approvalType} تایید شد.`
            : `درخواست ${decision.approvalType} رد شد.`,
        relatedEntityType: decision.entityType,
        relatedEntityId: decision.entityId,
      });
    }
    return decision;
  }
}
