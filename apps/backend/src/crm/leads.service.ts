import { Injectable } from '@nestjs/common';
import { Lead, LeadStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { assertActiveCompanyMember } from '../common/utils/company-member';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateLeadDto,
  LeadQueryDto,
  UpdateLeadDto,
} from './crm.dto';

/**
 * Leads (REQUIREMENTS §8 SALES CRM FLOW): a Lead is NOT the customer party;
 * it may optionally reference one. Status chain NEW → CONTACTED →
 * QUALIFIED/LOST is backend-enforced.
 */

const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: [LeadStatus.CONTACTED],
  CONTACTED: [LeadStatus.QUALIFIED, LeadStatus.LOST],
  QUALIFIED: [],
  LOST: [],
};

function assertLeadTransition(from: LeadStatus, to: LeadStatus): void {
  if (from !== to && !LEAD_TRANSITIONS[from].includes(to)) {
    throw new ValidationError('INVALID_LEAD_STATUS_TRANSITION', { from, to });
  }
}

@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(
    companyId: string,
    dto: CreateLeadDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Lead> {
    if (dto.partyId) {
      const party = await this.prisma.party.findFirst({
        where: { id: dto.partyId, companyId, archivedAt: null },
        select: { id: true },
      });
      if (!party) throw new NotFoundError('Party not found', { partyId: dto.partyId });
    }
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
      return lead;
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateLeadDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Lead> {
    const existing = await this.prisma.lead.findFirst({ where: { id, companyId } });
    if (!existing) throw new NotFoundError('Lead not found', { id });

    if (dto.partyId) {
      const party = await this.prisma.party.findFirst({
        where: { id: dto.partyId, companyId, archivedAt: null },
        select: { id: true },
      });
      if (!party) throw new NotFoundError('Party not found', { partyId: dto.partyId });
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
    return updated;
  }

  async getById(companyId: string, id: string): Promise<Lead> {
    const lead = await this.prisma.lead.findFirst({
      where: { id, companyId },
      include: {
        party: { select: { id: true, nameFa: true } },
        salesperson: { select: { id: true, username: true, firstName: true, lastName: true } },
      },
    });
    if (!lead) throw new NotFoundError('Lead not found', { id });
    return lead;
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
