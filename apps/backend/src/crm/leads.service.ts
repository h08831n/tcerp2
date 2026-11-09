import { Injectable } from '@nestjs/common';
import { Lead, LeadStatus, PartyRoleType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { assertActiveCompanyMember } from '../common/utils/company-member';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { TimelineService } from '../parties/timeline.service';
import { crmActivitySummary, CrmActivitySummary } from './crm-activity-summary';
import { CreateLeadDto, LeadQueryDto, UpdateLeadDto } from './crm.dto';

/**
 * CR-001 Revision 2 — a LEAD is a PARTY with the LEAD role.
 *
 *  - Creating a lead creates (or links) a Party, grants the LEAD role, and
 *    writes the supplementary CRM record — ALL in ONE transaction (a half
 *    -created lead without its Party can never exist).
 *  - The Party is the stable identity: the lead "detail" IS the party page.
 *  - Customer conversion happens on the FIRST successful quotation save
 *    (sales-documents.service.createInternal) — NOT here. This service never
 *    grants CUSTOMER.
 *  - Active leads = parties holding LEAD and NOT holding CUSTOMER; history
 *    (the LEAD role row + timeline) survives conversion.
 *  - The Opportunity stage is GONE from the operational flow (R2 §1): the
 *    convert-to-opportunity operation was removed; existing Opportunity rows
 *    and their historical links remain untouched in the database.
 */

const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: [LeadStatus.CONTACTED],
  CONTACTED: [LeadStatus.QUALIFIED, LeadStatus.LOST],
  QUALIFIED: [],
  LOST: [],
  CONVERTED: [],
};

function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (from !== to && !LEAD_TRANSITIONS[from].includes(to)) {
    throw new ValidationError('INVALID_LEAD_STATUS_TRANSITION', { from, to });
  }
}

export interface LeadWithSummary extends Lead {
  activity: CrmActivitySummary;
  party: { id: string; nameFa: string; type: string } | null;
  salesperson: { id: string; username: string; firstName: string | null; lastName: string | null } | null;
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  private async assertPartyInCompany(companyId: string, partyId: string): Promise<void> {
    // Backend-definitive: DTO validation is NOT trusted — an absent id must
    // fail HERE (Prisma would silently ignore `id: undefined`).
    if (!partyId) throw new ValidationError('LEAD_PARTY_REQUIRED', { partyId });
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId, archivedAt: null },
      select: { id: true },
    });
    if (!party) throw new NotFoundError('Party not found', { partyId });
  }

  /**
   * R2 §2 — create the lead: Party (new or existing) + LEAD role + the
   * supplementary CRM record, atomically. An existing party is NEVER
   * duplicated — when `partyId` is given the lead attaches to it.
   */
  async create(
    companyId: string,
    dto: CreateLeadDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<LeadWithSummary> {
    if (dto.assignedSalespersonId) {
      await assertActiveCompanyMember(
        this.prisma,
        companyId,
        dto.assignedSalespersonId,
        'SALESPERSON_NOT_COMPANY_MEMBER',
      );
    }
    if (dto.partyId) {
      await this.assertPartyInCompany(companyId, dto.partyId);
    } else if (!dto.name || dto.name.trim().length === 0) {
      // Creating a NEW party identity requires at least a name.
      throw new ValidationError('LEAD_NAME_REQUIRED', {});
    }

    return this.prisma.$transaction(async (tx) => {
      // 1. Party: link the EXISTING one or create a NEW identity.
      let partyId = dto.partyId ?? '';
      let partyName = dto.name.trim();
      if (partyId) {
        const party = await tx.party.findFirst({
          where: { id: partyId, companyId, archivedAt: null },
          select: { id: true, nameFa: true },
        });
        if (!party) throw new NotFoundError('Party not found', { partyId });
        partyName = party.nameFa;
      } else {
        const party = await tx.party.create({
          data: {
            companyId,
            type: dto.type ?? 'COMPANY',
            nameFa: dto.name.trim(),
            createdBy: actor.id,
          },
        });
        partyId = party.id;
      }

      // 2. LEAD role (idempotent — an existing party may already hold it).
      await tx.partyRole.upsert({
        where: { partyId_role: { partyId, role: PartyRoleType.LEAD } },
        create: { partyId, role: PartyRoleType.LEAD },
        update: {},
      });

      // 3. The supplementary CRM record.
      const lead = await tx.lead.create({
        data: {
          companyId,
          name: dto.name.trim(),
          partyId,
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
        entityType: 'PARTY',
        entityId: partyId,
        type: 'LEAD_CREATED',
        title: 'سرنخ ثبت شد',
        description: `«${partyName}» به‌عنوان سرنخ ثبت شد${dto.source ? ` (منبع: ${dto.source})` : ''}`,
        data: { leadId: lead.id, partyId, source: dto.source ?? null },
        actorUserId: actor.id,
      });
      await this.auditService.recordTx(tx, {
        entityType: 'lead',
        entityId: lead.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: { name: lead.name, partyId, status: lead.status, source: lead.source },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return {
        ...lead,
        partyId,
        activity: await crmActivitySummary(this.prisma, companyId, 'lead', lead.id),
        party: { id: partyId, nameFa: partyName, type: dto.type ?? 'COMPANY' },
        salesperson: null,
      };
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
      assertLeadTransition(existing.status, dto.status);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.lead.update({
        where: { id: existing.id, version: dto.version },
        data: {
          name: dto.name,
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
      if (dto.assignedSalespersonId && dto.assignedSalespersonId !== existing.assignedSalespersonId) {
        await this.timeline.record(tx, {
          companyId,
          entityType: 'PARTY',
          entityId: existing.partyId ?? '',
          type: 'OWNER_CHANGED',
          title: 'مسئول پیگیری تغییر کرد',
          description: `مسئول پیگیری سرنخ «${existing.name}» به کاربر جدید سپرده شد`,
          data: { leadId: existing.id, salespersonUserId: dto.assignedSalespersonId },
          actorUserId: actor.id,
        });
      }
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
    return this.attachSummary(updated);
  }

  private async attachSummary(lead: Lead): Promise<LeadWithSummary> {
    const [party, salesperson, activity] = await Promise.all([
      lead.partyId
        ? this.prisma.party.findFirst({
            where: { id: lead.partyId },
            select: { id: true, nameFa: true, type: true },
          })
        : Promise.resolve(null),
      lead.assignedSalespersonId
        ? this.prisma.user.findFirst({
            where: { id: lead.assignedSalespersonId },
            select: { id: true, username: true, firstName: true, lastName: true },
          })
        : Promise.resolve(null),
      crmActivitySummary(this.prisma, lead.companyId, 'lead', lead.id),
    ]);
    return {
      ...lead,
      party: party ? { id: party.id, nameFa: party.nameFa, type: party.type } : null,
      salesperson: salesperson ?? null,
      activity,
    };
  }

  async getById(companyId: string, id: string): Promise<LeadWithSummary> {
    const lead = await this.prisma.lead.findFirst({ where: { id, companyId } });
    if (!lead) throw new NotFoundError('Lead not found', { id });
    return this.attachSummary(lead);
  }

  /**
   * R2 §5 — ACTIVE leads: parties holding the LEAD role and NOT holding the
   * CUSTOMER role (a converted party leaves the active list; its LEAD history
   * stays). The supplementary Lead record (if any) is joined for CRM fields.
   */
  async list(companyId: string, query: LeadQueryDto): Promise<Paginated<LeadWithSummary>> {
    const where: Prisma.PartyWhereInput = {
      companyId,
      archivedAt: null,
      roles: { some: { role: PartyRoleType.LEAD } },
      ...(query.search
        ? {
            OR: [
              { nameFa: { contains: query.search, mode: 'insensitive' } },
              { phones: { some: { rawValue: { contains: query.search } } } },
              { phones: { some: { normalizedValue: { contains: query.search } } } },
            ],
          }
        : {}),
    };
    const [parties, total] = await Promise.all([
      this.prisma.party.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
        include: { roles: { select: { role: true } } },
      }),
      this.prisma.party.count({ where }),
    ]);
    // Customer-role parties leave the ACTIVE list (post-filter on the fetched
    // page's roles — the include already carries them).
    const active = parties.filter((p) => !p.roles.some((r) => r.role === PartyRoleType.CUSTOMER));
    const partyIds = active.map((p) => p.id);
    const leadRows = partyIds.length
      ? await this.prisma.lead.findMany({
          where: { companyId, partyId: { in: partyIds } },
          orderBy: { createdAt: 'desc' },
        })
      : [];
    const leadByParty = new Map(leadRows.map((l) => [l.partyId ?? '', l]));
    const summaries = await Promise.all(
      active.map(async (p) => {
        const row = leadByParty.get(p.id);
        const summary = await crmActivitySummary(this.prisma, companyId, 'lead', row?.id ?? p.id);
        return {
          id: row?.id ?? p.id,
          companyId,
          partyId: p.id,
          name: row?.name ?? p.nameFa,
          phone: row?.phone ?? null,
          source: row?.source ?? null,
          campaign: row?.campaign ?? null,
          media: row?.media ?? null,
          referrer: row?.referrer ?? null,
          assignedSalespersonId: row?.assignedSalespersonId ?? null,
          status: row?.status ?? LeadStatus.NEW,
          notes: row?.notes ?? null,
          createdBy: row?.createdBy ?? null,
          createdAt: row?.createdAt ?? p.createdAt,
          updatedAt: row?.updatedAt ?? p.updatedAt,
          version: row?.version ?? 1,
          activity: summary,
          party: { id: p.id, nameFa: p.nameFa, type: p.type },
          salesperson: null,
        } satisfies LeadWithSummary;
      }),
    );
    return { items: summaries, total, page: query.page, pageSize: query.pageSize };
  }

  /** CORE-003 — lead source options from the company settings (real consumer). */
  async sourceOptions(companyId: string): Promise<{ options: string[] }> {
    const row = await this.prisma.setting.findUnique({
      where: { companyId_key: { companyId, key: 'crm.lead_sources' } },
      select: { value: true },
    });
    const raw = row?.value;
    if (Array.isArray(raw)) {
      return { options: raw.map(String).filter(Boolean) };
    }
    if (typeof raw === 'string' && raw.trim()) {
      return { options: raw.split(',').map((x) => x.trim()).filter(Boolean) };
    }
    return { options: ['WEB_SITE', 'REFERRAL', 'EXHIBITION', 'GOOGLE_ADS', 'COLD_CALL'] };
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
