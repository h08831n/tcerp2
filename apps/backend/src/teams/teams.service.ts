import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreateTeamDto, TeamQueryDto, UpdateTeamDto } from './teams.dto';
import { Paginated } from '../common/dto/pagination.dto';

const TEAM_SELECT = {
  id: true,
  companyId: true,
  name: true,
  managerId: true,
  createdAt: true,
  updatedAt: true,
  members: {
    select: {
      userId: true,
      joinedAt: true,
      user: { select: { username: true, firstName: true, lastName: true } },
    },
  },
} satisfies Prisma.TeamSelect;

export type TeamWithMembers = Prisma.TeamGetPayload<{ select: typeof TEAM_SELECT }>;

function toDto(team: TeamWithMembers): Record<string, unknown> {
  const { members, ...rest } = team;
  return { ...rest, memberIds: members.map((m) => m.userId) };
}

/** Company-scoped teams. */
@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(companyId: string, query: TeamQueryDto): Promise<Paginated<TeamWithMembers>> {
    const where: Prisma.TeamWhereInput = {
      companyId,
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' as const } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.team.findMany({
        where,
        select: TEAM_SELECT,
        orderBy: { name: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.team.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(companyId: string, id: string): Promise<TeamWithMembers> {
    const team = await this.prisma.team.findUnique({ where: { id }, select: TEAM_SELECT });
    if (!team || team.companyId !== companyId) {
      throw new NotFoundError('Team not found', { id });
    }
    return team;
  }

  async create(
    companyId: string,
    dto: CreateTeamDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<TeamWithMembers> {
    const duplicate = await this.prisma.team.findFirst({
      where: { companyId, name: dto.name },
    });
    if (duplicate) throw new ConflictError('Team name already exists', { name: dto.name });

    const memberIds = dto.memberIds ?? [];
    await this.assertUsersExist(memberIds);
    if (dto.managerId) await this.assertUsersExist([dto.managerId]);

    const team = await this.prisma.team.create({
      data: {
        companyId,
        name: dto.name,
        managerId: dto.managerId,
        members: { create: [...new Set(memberIds)].map((userId) => ({ userId })) },
      },
      select: TEAM_SELECT,
    });
    await this.auditService.record({
      entityType: 'team',
      entityId: team.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: toDto(team),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return team;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateTeamDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<TeamWithMembers> {
    const existing = await this.prisma.team.findUnique({
      where: { id },
      include: { members: { select: { userId: true } } },
    });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Team not found', { id });
    }

    if (dto.managerId) await this.assertUsersExist([dto.managerId]);

    const memberIds = dto.memberIds;
    const oldMemberIds = existing.members.map((m) => m.userId).sort();

    const team = await this.prisma.$transaction(async (trx) => {
      await trx.team.update({
        where: { id },
        data: {
          name: dto.name,
          managerId: dto.managerId === undefined ? undefined : dto.managerId,
        },
      });
      if (memberIds !== undefined) {
        const uniqueIds = [...new Set(memberIds)].sort();
        if (oldMemberIds.join(',') !== uniqueIds.join(',')) {
          await trx.teamMember.deleteMany({ where: { teamId: id } });
          if (uniqueIds.length > 0) {
            await trx.teamMember.createMany({
              data: uniqueIds.map((userId) => ({ teamId: id, userId })),
            });
          }
        }
      }
      return trx.team.findUniqueOrThrow({ where: { id }, select: TEAM_SELECT });
    });

    await this.auditService.record({
      entityType: 'team',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId,
      oldValues: { name: existing.name, managerId: existing.managerId, memberIds: oldMemberIds },
      newValues: toDto(team),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return team;
  }

  async remove(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.prisma.team.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Team not found', { id });
    }
    await this.prisma.team.delete({ where: { id } }); // members cascade (schema)
    await this.auditService.record({
      entityType: 'team',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      companyId,
      oldValues: { name: existing.name, managerId: existing.managerId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  private async assertUsersExist(userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    const count = await this.prisma.user.count({ where: { id: { in: userIds } } });
    if (count !== userIds.length) {
      throw new ValidationError('One or more user ids do not exist', { userIds });
    }
  }
}
