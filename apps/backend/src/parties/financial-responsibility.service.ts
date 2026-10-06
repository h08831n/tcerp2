import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError } from '../common/errors';
import { mapUniqueViolation } from './parties.service';
import { TimelineService } from './timeline.service';

export interface FinancialGroupView {
  group: { responsiblePartyId: string; nameFa: string };
  members: {
    partyId: string;
    nameFa: string;
    score: number | null;
    isResponsible: boolean;
    balance: number | null;
  }[];
  consolidatedAvailable: boolean;
  consolidatedBalance: number;
  note: string;
}

/**
 * Financial responsibility groups (REQUIREMENTS §38/§100): a responsible
 * party answers for several member parties without merging identities.
 * A member belongs to at most one group per company (DB unique
 * `financial_responsibilities_company_id_member_party_id_key`, mirrored in
 * the service for readable errors).
 *
 * Balances are read from `party_operational_balances` when present (cached
 * operational balance); real accounting balances land in Phase 7, so a
 * missing balance row reports `balance: null` and the consolidated figure
 * only sums what exists.
 */
@Injectable()
export class FinancialResponsibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly timeline: TimelineService,
  ) {}

  private async getPartyOrThrow(companyId: string, partyId: string) {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId },
      select: { id: true, nameFa: true, archivedAt: true },
    });
    if (!party) {
      throw new NotFoundError('Party not found', { partyId });
    }
    return party;
  }

  /** POST /parties/:id/financial-responsibility — adds `partyId` as member of the responsible group. */
  async addMember(
    companyId: string,
    memberPartyId: string,
    dto: { responsiblePartyId: string; note?: string },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    if (dto.responsiblePartyId === memberPartyId) {
      throw new ConflictError('SELF_RESPONSIBILITY', { partyId: memberPartyId });
    }
    await this.getPartyOrThrow(companyId, memberPartyId);
    await this.getPartyOrThrow(companyId, dto.responsiblePartyId);

    const existing = await this.prisma.financialResponsibility.findUnique({
      where: {
        companyId_memberPartyId: { companyId, memberPartyId },
      },
      select: { responsiblePartyId: true },
    });
    if (existing) {
      if (existing.responsiblePartyId === dto.responsiblePartyId) {
        throw new ConflictError('ALREADY_MEMBER', {
          memberPartyId,
          responsiblePartyId: dto.responsiblePartyId,
        });
      }
      throw new ConflictError('ALREADY_IN_GROUP', {
        memberPartyId,
        currentResponsiblePartyId: existing.responsiblePartyId,
      });
    }

    let membership;
    try {
      membership = await this.prisma.financialResponsibility.create({
        data: {
          companyId,
          responsiblePartyId: dto.responsiblePartyId,
          memberPartyId,
          note: dto.note,
        },
      });
    } catch (error) {
      const mapped = mapUniqueViolation(error, () => ({
        token: 'ALREADY_IN_GROUP',
        details: { memberPartyId },
      }));
      throw mapped ?? error;
    }

    await this.timeline.record(this.prisma, {
      companyId,
      entityType: 'PARTY',
      entityId: memberPartyId,
      type: 'FINANCIAL_RESPONSIBILITY_ADDED',
      title: 'افزودن به گروه مسئولیت مالی',
      data: { partyId: memberPartyId, responsiblePartyId: dto.responsiblePartyId },
      actorUserId: actor.id,
    });
    await this.timeline.record(this.prisma, {
      companyId,
      entityType: 'PARTY',
      entityId: dto.responsiblePartyId,
      type: 'FINANCIAL_RESPONSIBILITY_MEMBER_ADDED',
      title: 'افزودن عضو به گروه مسئولیت مالی',
      data: { partyId: dto.responsiblePartyId, memberPartyId },
      actorUserId: actor.id,
    });
    await this.auditService.record({
      entityType: 'financial_responsibility',
      entityId: membership.id,
      action: 'FINANCIAL_RESPONSIBILITY_ADDED',
      actor,
      companyId,
      newValues: { memberPartyId, responsiblePartyId: dto.responsiblePartyId, note: dto.note },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return membership;
  }

  /** DELETE /parties/:id/financial-responsibility — removes the membership. */
  async removeMembership(
    companyId: string,
    memberPartyId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.financialResponsibility.findUnique({
      where: { companyId_memberPartyId: { companyId, memberPartyId } },
    });
    if (!existing) {
      throw new NotFoundError('Party does not belong to a financial responsibility group', {
        partyId: memberPartyId,
      });
    }
    await this.prisma.financialResponsibility.delete({ where: { id: existing.id } });

    await this.timeline.record(this.prisma, {
      companyId,
      entityType: 'PARTY',
      entityId: memberPartyId,
      type: 'FINANCIAL_RESPONSIBILITY_REMOVED',
      title: 'حذف از گروه مسئولیت مالی',
      data: { partyId: memberPartyId, responsiblePartyId: existing.responsiblePartyId },
      actorUserId: actor.id,
    });
    await this.auditService.record({
      entityType: 'financial_responsibility',
      entityId: existing.id,
      action: 'FINANCIAL_RESPONSIBILITY_REMOVED',
      actor,
      companyId,
      oldValues: {
        memberPartyId,
        responsiblePartyId: existing.responsiblePartyId,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { removed: true, memberPartyId };
  }

  /** GET /parties/:id/financial-responsibility — group view + consolidated balances. */
  async getGroup(companyId: string, partyId: string): Promise<FinancialGroupView> {
    await this.getPartyOrThrow(companyId, partyId);

    let responsiblePartyId: string | null = null;
    const membership = await this.prisma.financialResponsibility.findUnique({
      where: { companyId_memberPartyId: { companyId, memberPartyId: partyId } },
      select: { responsiblePartyId: true },
    });
    if (membership) {
      responsiblePartyId = membership.responsiblePartyId;
    } else {
      const ownGroup = await this.prisma.financialResponsibility.findFirst({
        where: { companyId, responsiblePartyId: partyId },
        select: { responsiblePartyId: true },
      });
      if (ownGroup) responsiblePartyId = partyId;
    }
    if (!responsiblePartyId) {
      throw new NotFoundError('Party does not belong to a financial responsibility group', {
        partyId,
      });
    }

    const [responsible, memberRows] = await Promise.all([
      this.prisma.party.findUnique({
        where: { id: responsiblePartyId },
        select: { id: true, nameFa: true, score: true },
      }),
      this.prisma.financialResponsibility.findMany({
        where: { companyId, responsiblePartyId },
        select: { memberParty: { select: { id: true, nameFa: true, score: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    if (!responsible) {
      throw new NotFoundError('Responsible party not found', { partyId: responsiblePartyId });
    }

    const partyIds = [responsiblePartyId, ...memberRows.map((m) => m.memberParty.id)];
    const balances = await this.prisma.partyOperationalBalance.findMany({
      where: { companyId, partyId: { in: partyIds } },
      select: { partyId: true, balance: true },
    });
    const balanceMap = new Map(balances.map((b) => [b.partyId, Number(b.balance)]));

    const members = [
      {
        partyId: responsible.id,
        nameFa: responsible.nameFa,
        score: responsible.score,
        isResponsible: true,
        balance: balanceMap.get(responsible.id) ?? null,
      },
      ...memberRows.map((m) => ({
        partyId: m.memberParty.id,
        nameFa: m.memberParty.nameFa,
        score: m.memberParty.score,
        isResponsible: false,
        balance: balanceMap.get(m.memberParty.id) ?? null,
      })),
    ];

    const consolidatedBalance = members.reduce(
      (sum, m) => sum + (m.balance ?? 0),
      0,
    );

    return {
      group: { responsiblePartyId: responsible.id, nameFa: responsible.nameFa },
      members,
      consolidatedAvailable: true,
      consolidatedBalance,
      note: 'Balances are read from party_operational_balances (operational cache, missing rows = null). Real accounting balances arrive in Phase 7.',
    };
  }
}
