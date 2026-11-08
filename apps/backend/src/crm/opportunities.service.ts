import { Injectable } from '@nestjs/common';
import { Opportunity, OpportunityStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { assertActiveCompanyMember } from '../common/utils/company-member';
import { moneyString } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { TimelineService } from '../parties/timeline.service';
import { crmActivitySummary, CrmActivitySummary } from './crm-activity-summary';
import { CreateOpportunityDto, OpportunityQueryDto, UpdateOpportunityDto } from './crm.dto';

/**
 * Opportunities (REQUIREMENTS §8 + CR-001): an Opportunity is created per
 * buying intent and is attached to a STABLE Party — which may be a plain
 * lead (NO CUSTOMER role required: the role is granted exclusively when a
 * Sales Order is activated, sales-documents.service.activate). Multiple
 * opportunities per party are allowed. Status chain OPEN → QUALIFIED →
 * QUOTED → WON/LOST is backend-enforced; `lostReasonId` is REQUIRED when
 * an opportunity is marked LOST.
 */

const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  OPEN: [OpportunityStatus.QUALIFIED, OpportunityStatus.LOST],
  QUALIFIED: [OpportunityStatus.QUOTED, OpportunityStatus.LOST],
  QUOTED: [OpportunityStatus.WON, OpportunityStatus.LOST],
  WON: [],
  LOST: [],
};

export interface OpportunityWithSummary extends Opportunity {
  activity: CrmActivitySummary;
}

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  private assertTransition(from: OpportunityStatus, to: OpportunityStatus): void {
    if (from !== to && !OPPORTUNITY_TRANSITIONS[from].includes(to)) {
      throw new ValidationError('INVALID_OPPORTUNITY_STATUS_TRANSITION', { from, to });
    }
  }

  private assertLostReason(dto: { status?: OpportunityStatus; lostReasonId?: string }, existing?: Opportunity): void {
    const target = dto.status ?? existing?.status;
    if (target === OpportunityStatus.LOST) {
      const reasonId = dto.lostReasonId ?? existing?.lostReasonId;
      if (!reasonId) throw new ValidationError('LOST_REASON_REQUIRED', { status: 'LOST' });
    }
  }

  private async assertLostReasonExists(companyId: string, lostReasonId: string): Promise<void> {
    const reason = await this.prisma.lostReason.findFirst({
      where: { id: lostReasonId, companyId },
      select: { id: true },
    });
    if (!reason) throw new NotFoundError('Lost reason not found', { lostReasonId });
  }

  private toCloseDate(expectedCloseDate: string | undefined): Date | undefined {
    // DATE column: anchor at UTC midnight — no timezone day-shift (R5-P1).
    return expectedCloseDate ? new Date(`${expectedCloseDate.slice(0, 10)}T00:00:00Z`) : undefined;
  }

  async create(
    companyId: string,
    dto: CreateOpportunityDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<OpportunityWithSummary> {
    // CR-001: NO customer-role requirement — an opportunity may exist for a
    // lead whose party is not (yet) a customer. Customer-hood is granted ONLY
    // by a valid Sales Order activation.
    await assertActiveCompanyMember(
      this.prisma,
      companyId,
      dto.salespersonUserId,
      'SALESPERSON_NOT_COMPANY_MEMBER',
    );

    return this.prisma.$transaction(async (tx) => {
      const opportunity = await tx.opportunity.create({
        data: {
          companyId,
          customerPartyId: dto.customerPartyId,
          salespersonUserId: dto.salespersonUserId,
          title: dto.title,
          description: dto.description,
          expectedCloseDate: this.toCloseDate(dto.expectedCloseDate),
          estimatedAmount: dto.estimatedAmount !== undefined ? moneyString(dto.estimatedAmount) : undefined,
          estimatedTonnage: dto.estimatedTonnage !== undefined ? moneyString(dto.estimatedTonnage) : undefined,
          source: dto.source,
        },
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: 'OPPORTUNITY',
        entityId: opportunity.id,
        type: 'OPPORTUNITY_CREATED',
        title: 'فرصت فروش ایجاد شد',
        description: `فرصت «${opportunity.title}» ثبت شد`,
        data: { opportunityId: opportunity.id, partyId: opportunity.customerPartyId },
        actorUserId: actor.id,
      });
      await this.auditService.recordTx(tx, {
        entityType: 'opportunity',
        entityId: opportunity.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: { title: opportunity.title, customerPartyId: opportunity.customerPartyId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return {
        ...opportunity,
        activity: await crmActivitySummary(this.prisma, companyId, 'opportunity', opportunity.id),
      };
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateOpportunityDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<OpportunityWithSummary> {
    const existing = await this.prisma.opportunity.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Opportunity not found', { id });

    if (dto.salespersonUserId) {
      await assertActiveCompanyMember(
        this.prisma,
        companyId,
        dto.salespersonUserId,
        'SALESPERSON_NOT_COMPANY_MEMBER',
      );
    }
    if (dto.status && dto.status !== existing.status) {
      this.assertTransition(existing.status, dto.status);
    }
    this.assertLostReason(dto, existing);
    if (dto.lostReasonId) {
      await this.assertLostReasonExists(companyId, dto.lostReasonId);
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.opportunity.update({
        where: { id: existing.id, version: dto.version },
        data: {
          customerPartyId: dto.customerPartyId,
          salespersonUserId: dto.salespersonUserId,
          title: dto.title,
          description: dto.description,
          expectedCloseDate: this.toCloseDate(dto.expectedCloseDate),
          estimatedAmount: dto.estimatedAmount !== undefined ? moneyString(dto.estimatedAmount) : undefined,
          estimatedTonnage: dto.estimatedTonnage !== undefined ? moneyString(dto.estimatedTonnage) : undefined,
          status: dto.status,
          lostReasonId: dto.lostReasonId,
          source: dto.source,
          version: { increment: 1 },
        },
      });
      if (updated.status !== existing.status) {
        await this.timeline.record(tx, {
          companyId,
          entityType: 'OPPORTUNITY',
          entityId: updated.id,
          type: 'OPPORTUNITY_STAGE_CHANGED',
          title: 'مرحله فرصت تغییر کرد',
          description: `${existing.status} → ${updated.status}`,
          data: { opportunityId: updated.id, from: existing.status, to: updated.status },
          actorUserId: actor.id,
        });
      }
      await this.auditService.recordTx(tx, {
        entityType: 'opportunity',
        entityId: updated.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: existing.status, title: existing.title },
        newValues: { status: updated.status, title: updated.title },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictError('VERSION_CONFLICT', { id });
      }
      throw error;
    });
    return { ...row, activity: await crmActivitySummary(this.prisma, companyId, 'opportunity', id) };
  }

  async getById(companyId: string, id: string): Promise<OpportunityWithSummary> {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { id: true, nameFa: true, type: true } },
        salesperson: { select: { id: true, username: true, firstName: true, lastName: true } },
        lostReason: { select: { id: true, nameFa: true, code: true } },
        lead: { select: { id: true, name: true } },
      },
    });
    if (!opportunity) throw new NotFoundError('Opportunity not found', { id });
    return {
      ...opportunity,
      activity: await crmActivitySummary(this.prisma, companyId, 'opportunity', id),
    };
  }

  async list(companyId: string, query: OpportunityQueryDto): Promise<Paginated<Opportunity>> {
    const where: Prisma.OpportunityWhereInput = {
      companyId,
      status: query.status,
      customerPartyId: query.customerPartyId,
      salespersonUserId: query.salespersonUserId,
      ...(query.search ? { title: { contains: query.search, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.opportunity.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          customer: { select: { id: true, nameFa: true } },
          salesperson: { select: { id: true, username: true } },
        },
      }),
      this.prisma.opportunity.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Timeline (Chatter) for the opportunity — same machinery as parties. */
  async timelineFor(
    companyId: string,
    id: string,
    options: { limit?: number } = {},
  ): Promise<ReturnType<TimelineService['listForEntity']>> {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!opportunity) throw new NotFoundError('Opportunity not found', { id });
    return this.timeline.listForEntity(companyId, 'OPPORTUNITY', id, options);
  }
}
