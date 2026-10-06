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
import { CreateOpportunityDto, OpportunityQueryDto, UpdateOpportunityDto } from './crm.dto';

/**
 * Opportunities (REQUIREMENTS §8): a (returning) customer gets a NEW
 * Opportunity per buying intent. The customer party MUST hold the CUSTOMER
 * role; the salesperson must be an active company member. Status chain
 * OPEN → QUALIFIED → QUOTED → WON/LOST; `lostReasonId` is REQUIRED when a
 * quotation is marked LOST.
 */

const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  OPEN: [OpportunityStatus.QUALIFIED, OpportunityStatus.LOST],
  QUALIFIED: [OpportunityStatus.QUOTED, OpportunityStatus.LOST],
  QUOTED: [OpportunityStatus.WON, OpportunityStatus.LOST],
  WON: [],
  LOST: [],
};

export const NOT_A_CUSTOMER = 'NOT_A_CUSTOMER';

@Injectable()
export class OpportunitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /** The party must hold the CUSTOMER role (p4-03). */
  async assertCustomerRole(companyId: string, partyId: string): Promise<void> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId },
      select: { id: true, roles: { where: { role: 'CUSTOMER' }, select: { id: true } } },
    });
    if (!party || party.roles.length === 0) {
      throw new ValidationError(NOT_A_CUSTOMER, { companyId, partyId });
    }
  }

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

  async create(
    companyId: string,
    dto: CreateOpportunityDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Opportunity> {
    await this.assertCustomerRole(companyId, dto.customerPartyId);
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
          estimatedAmount: dto.estimatedAmount !== undefined ? moneyString(dto.estimatedAmount) : undefined,
          estimatedTonnage: dto.estimatedTonnage !== undefined ? moneyString(dto.estimatedTonnage) : undefined,
          source: dto.source,
        },
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
      return opportunity;
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateOpportunityDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Opportunity> {
    const existing = await this.prisma.opportunity.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Opportunity not found', { id });

    if (dto.customerPartyId && dto.customerPartyId !== existing.customerPartyId) {
      await this.assertCustomerRole(companyId, dto.customerPartyId);
    }
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

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.opportunity.update({
        where: { id: existing.id, version: dto.version },
        data: {
          customerPartyId: dto.customerPartyId,
          salespersonUserId: dto.salespersonUserId,
          title: dto.title,
          description: dto.description,
          estimatedAmount: dto.estimatedAmount !== undefined ? moneyString(dto.estimatedAmount) : undefined,
          estimatedTonnage: dto.estimatedTonnage !== undefined ? moneyString(dto.estimatedTonnage) : undefined,
          status: dto.status,
          lostReasonId: dto.lostReasonId,
          source: dto.source,
          version: { increment: 1 },
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'opportunity',
        entityId: row.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: existing.status, title: existing.title },
        newValues: { status: row.status, title: row.title },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    }).catch((error) => {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new ConflictError('VERSION_CONFLICT', { id });
      }
      throw error;
    });
  }

  async getById(companyId: string, id: string): Promise<Opportunity> {
    const opportunity = await this.prisma.opportunity.findFirst({
      where: { id, companyId },
      include: {
        customer: { select: { id: true, nameFa: true } },
        salesperson: { select: { id: true, username: true, firstName: true, lastName: true } },
        lostReason: { select: { id: true, nameFa: true, code: true } },
      },
    });
    if (!opportunity) throw new NotFoundError('Opportunity not found', { id });
    return opportunity;
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
}
