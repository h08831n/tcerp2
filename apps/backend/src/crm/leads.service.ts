import { Injectable } from '@nestjs/common';
import { Lead, LeadStatus, Prisma } from '@prisma/client';
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
import {
  ConvertLeadDto,
  CreateLeadDto,
  LeadQueryDto,
  UpdateLeadDto,
} from './crm.dto';

/**
 * Leads (REQUIREMENTS §8 SALES CRM FLOW + CR-001):
 *  - a Lead is ALWAYS attached to a Party (the party is the stable identity;
 *    conversion NEVER creates a second party row);
 *  - status chain NEW → CONTACTED → QUALIFIED/LOST is backend-enforced;
 *    CONVERTED is TERMINAL and set ONLY by the explicit convert operation
 *    (a plain status PATCH can never reach it);
 *  - the CUSTOMER role is NOT touched anywhere in the lead flow — it is
 *    granted exclusively by a valid Sales Order activation (CR-001 §7).
 */

const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: [LeadStatus.CONTACTED],
  CONTACTED: [LeadStatus.QUALIFIED, LeadStatus.LOST],
  QUALIFIED: [],
  LOST: [],
  // Terminal: leaving CONVERTED is impossible (re-conversion is idempotent
  // through Opportunity.leadId, never through a status change).
  CONVERTED: [],
};

function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (from !== to && !LEAD_TRANSITIONS[from].includes(to)) {
    throw new ValidationError('INVALID_LEAD_STATUS_TRANSITION', { from, to });
  }
}

export interface LeadWithSummary extends Lead {
  activity: CrmActivitySummary;
}

export interface ConvertLeadResult {
  opportunity: { id: string; title: string; customerPartyId: string; leadId: string | null };
  /** true when this call found the conversion already done (idempotent replay). */
  alreadyConverted: boolean;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  private async assertPartyInCompany(companyId: string, partyId: string): Promise<void> {
    // Backend-definitive: DTO validation is NOT trusted (CR-001). An absent
    // id must fail HERE — otherwise Prisma would ignore  and
    // match ANY party in the company.
    if (!partyId) throw new ValidationError('LEAD_PARTY_REQUIRED', { partyId });
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId, archivedAt: null },
      select: { id: true },
    });
    if (!party) throw new NotFoundError('Party not found', { partyId });
  }

  async create(
    companyId: string,
    dto: CreateLeadDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<LeadWithSummary> {
    // CR-001: partyId is REQUIRED — a lead without a party identity cannot
    // be followed up, converted, or kept as one record.
    await this.assertPartyInCompany(companyId, dto.partyId);
    if (dto.assignedSalespersonId) {
      await assertActiveCompanyMember(
        this.prisma,
        companyId,
        dto.assignedSalespersonId,
        'SALESPERSON_NOT_COMPANY_MEMBER',
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.create({
        data: {
          companyId,
          name: dto.name,
          partyId: dto.partyId,
          phone: dto.phone,
          source: dto.source,
          campaign: dto.campaign,
          media: dto.media,
          referrer: dto.referrer,
          assignedSalespersonId: dto.assignedSalespersonId,
          notes: dto.notes,
          createdBy: actor.id,
        },
      });
      await this.timeline.record(tx, {
        companyId,
        entityType: 'LEAD',
        entityId: lead.id,
        type: 'LEAD_CREATED',
        title: 'سرنخ ثبت شد',
        description: `سرنخ «${lead.name}» ایجاد شد`,
        data: { leadId: lead.id, partyId: lead.partyId, source: lead.source },
        actorUserId: actor.id,
      });
      await this.auditService.recordTx(tx, {
        entityType: 'lead',
        entityId: lead.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: { name: lead.name, status: lead.status, partyId: lead.partyId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ...lead, activity: await crmActivitySummary(this.prisma, companyId, 'lead', lead.id) };
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateLeadDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<LeadWithSummary> {
    const existing = await this.prisma.lead.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Lead not found', { id });

    if (dto.partyId) {
      await this.assertPartyInCompany(companyId, dto.partyId);
    }
    if (dto.assignedSalespersonId) {
      await assertActiveCompanyMember(
        this.prisma,
        companyId,
        dto.assignedSalespersonId,
        'SALESPERSON_NOT_COMPANY_MEMBER',
      );
    }
    if (dto.status && dto.status !== existing.status) {
      // CONVERTED is reachable ONLY via the convert operation — a plain
      // status PATCH can never set it (CR-001: the conversion must record
      // traceability, which a generic patch cannot provide).
      if (dto.status === LeadStatus.CONVERTED) {
        throw new ValidationError('LEAD_CONVERT_REQUIRES_CONVERT_OPERATION', { id });
      }
      assertLeadTransition(existing.status, dto.status);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({
        where: { id: existing.id, version: dto.version },
        data: {
          name: dto.name,
          partyId: dto.partyId,
          phone: dto.phone,
          source: dto.source,
          campaign: dto.campaign,
          media: dto.media,
          referrer: dto.referrer,
          assignedSalespersonId: dto.assignedSalespersonId,
          status: dto.status,
          notes: dto.notes,
          version: { increment: 1 },
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'lead',
        entityId: row.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { status: existing.status, name: existing.name, notes: existing.notes },
        newValues: { status: row.status, name: row.name, notes: row.notes },
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
    return { ...updated, activity: await crmActivitySummary(this.prisma, companyId, 'lead', id) };
  }

  /**
   * CR-001 §3 — «تبدیل به فرصت فروش».
   * Same Party, same history, same owner (unless explicitly reassigned);
   * conversion is user-authorized (crm.manage), NEVER automatic from an
   * activity; idempotent by Opportunity.leadId UNIQUE — a replayed request
   * returns the EXISTING opportunity instead of creating a duplicate.
   */
  async convert(
    companyId: string,
    id: string,
    dto: ConvertLeadDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<ConvertLeadResult> {
    const lead = await this.prisma.lead.findFirst({
      where: { id, companyId },
      include: { party: { select: { id: true, nameFa: true } } },
    });
    if (!lead) throw new NotFoundError('Lead not found', { id });
    if (!lead.partyId) {
      // Legacy rows created before CR-001 (partyId was optional then).
      throw new ValidationError('LEAD_PARTY_REQUIRED', { id });
    }
    if (lead.status === LeadStatus.CONVERTED) {
      const existing = await this.prisma.opportunity.findUnique({ where: { leadId: lead.id } });
      if (existing) {
        return {
          opportunity: {
            id: existing.id,
            title: existing.title,
            customerPartyId: existing.customerPartyId,
            leadId: existing.leadId,
          },
          alreadyConverted: true,
        };
      }
      // CONVERTED without a linked opportunity = torn state; heal by falling
      // through to the create below (leadId unique arbitrates concurrency).
    }
    if (lead.status === LeadStatus.LOST) {
      throw new ValidationError('LEAD_LOST_CANNOT_CONVERT', { id });
    }
    const salespersonUserId = dto.salespersonUserId ?? lead.assignedSalespersonId ?? actor.id;
    await assertActiveCompanyMember(this.prisma, companyId, salespersonUserId, 'SALESPERSON_NOT_COMPANY_MEMBER');

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        const opportunity = await tx.opportunity.create({
          data: {
            companyId,
            customerPartyId: lead.partyId!,
            salespersonUserId,
            title: dto.title ?? lead.name,
            description: lead.notes ?? undefined,
            source: lead.source ?? undefined,
            leadId: lead.id,
            expectedCloseDate: dto.expectedCloseDate ? new Date(`${dto.expectedCloseDate.slice(0, 10)}T00:00:00Z`) : undefined,
            estimatedAmount: dto.estimatedAmount !== undefined ? moneyString(dto.estimatedAmount) : undefined,
            estimatedTonnage: dto.estimatedTonnage !== undefined ? moneyString(dto.estimatedTonnage) : undefined,
          },
        });
        // CAS: only a still-unconverted lead flips to CONVERTED. Losing the
        // race (count 0) means a concurrent request won — ours becomes the
        // idempotent replay path.
        const flipped = await tx.lead.updateMany({
          where: { id: lead.id, version: lead.version, status: { notIn: [LeadStatus.CONVERTED, LeadStatus.LOST] } },
          data: { status: LeadStatus.CONVERTED, version: { increment: 1 } },
        });
        if (flipped.count !== 1) {
          throw new ConflictError('LEAD_CONVERSION_RACE', { id });
        }
        await this.timeline.record(tx, {
          companyId,
          entityType: 'LEAD',
          entityId: lead.id,
          type: 'LEAD_CONVERTED',
          title: 'سرنخ به فرصت فروش تبدیل شد',
          description: `سرنخ «${lead.name}» به فرصت «${opportunity.title}» تبدیل شد`,
          data: { leadId: lead.id, opportunityId: opportunity.id, partyId: lead.partyId },
          actorUserId: actor.id,
        });
        await this.timeline.record(tx, {
          companyId,
          entityType: 'OPPORTUNITY',
          entityId: opportunity.id,
          type: 'OPPORTUNITY_CREATED',
          title: 'فرصت فروش ایجاد شد',
          description: `از تبدیل سرنخ «${lead.name}» ساخته شد`,
          data: { opportunityId: opportunity.id, leadId: lead.id, partyId: lead.partyId },
          actorUserId: actor.id,
        });
        await this.auditService.recordTx(tx, {
          entityType: 'lead',
          entityId: lead.id,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: { status: lead.status },
          newValues: { status: LeadStatus.CONVERTED, opportunityId: opportunity.id },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        await this.auditService.recordTx(tx, {
          entityType: 'opportunity',
          entityId: opportunity.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: {
            title: opportunity.title,
            customerPartyId: opportunity.customerPartyId,
            leadId: opportunity.leadId,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return opportunity;
      });
      return {
        opportunity: {
          id: result.id,
          title: result.title,
          customerPartyId: result.customerPartyId,
          leadId: result.leadId,
        },
        alreadyConverted: false,
      };
    } catch (error) {
      // Idempotency net: even if the CAS above somehow raced, the UNIQUE
      // (lead_id) index guarantees ONE opportunity per lead — a loser
      // re-fetches and reports the winner instead of erroring.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await this.prisma.opportunity.findUnique({ where: { leadId: lead.id } });
        if (existing) {
          return {
            opportunity: {
              id: existing.id,
              title: existing.title,
              customerPartyId: existing.customerPartyId,
              leadId: existing.leadId,
            },
            alreadyConverted: true,
          };
        }
      }
      if (error instanceof ConflictError && error.message === 'LEAD_CONVERSION_RACE') {
        const existing = await this.prisma.opportunity.findUnique({ where: { leadId: lead.id } });
        if (existing) {
          return {
            opportunity: {
              id: existing.id,
              title: existing.title,
              customerPartyId: existing.customerPartyId,
              leadId: existing.leadId,
            },
            alreadyConverted: true,
          };
        }
      }
      throw error;
    }
  }

  async getById(companyId: string, id: string): Promise<LeadWithSummary> {
    const lead = await this.prisma.lead.findFirst({
      where: { id, companyId },
      include: {
        party: { select: { id: true, nameFa: true, type: true } },
        salesperson: { select: { id: true, username: true, firstName: true, lastName: true } },
      },
    });
    if (!lead) throw new NotFoundError('Lead not found', { id });
    return { ...lead, activity: await crmActivitySummary(this.prisma, companyId, 'lead', id) };
  }

  async list(companyId: string, query: LeadQueryDto): Promise<Paginated<Lead>> {
    const where: Prisma.LeadWhereInput = {
      companyId,
      status: query.status,
      partyId: query.partyId,
      assignedSalespersonId: query.assignedSalespersonId,
      ...(query.search
        ? { OR: [{ name: { contains: query.search, mode: 'insensitive' } }, { phone: { contains: query.search } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.lead.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          party: { select: { id: true, nameFa: true } },
          salesperson: { select: { id: true, username: true } },
        },
      }),
      this.prisma.lead.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Timeline (Chatter) for the lead — same TimelineEvent machinery as parties. */
  async timelineFor(
    companyId: string,
    id: string,
    options: { limit?: number } = {},
  ): Promise<ReturnType<TimelineService['listForEntity']>> {
    const lead = await this.prisma.lead.findFirst({ where: { id, companyId }, select: { id: true } });
    if (!lead) throw new NotFoundError('Lead not found', { id });
    return this.timeline.listForEntity(companyId, 'LEAD', id, options);
  }

  async archive(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.prisma.lead.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Lead not found', { id });
    await this.prisma.$transaction(async (tx) => {
      await tx.lead.delete({ where: { id } });
      await this.auditService.recordTx(tx, {
        entityType: 'lead',
        entityId: id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { name: existing.name, status: existing.status },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }
}
