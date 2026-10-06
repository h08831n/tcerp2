import { Injectable } from '@nestjs/common';
import { Prisma, Company } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreateCompanyDto, UpdateCompanyDto } from './companies.dto';

/**
 * Pure repair planner for the default-company invariant (mini-03):
 * users.default_company_id must be a company the user is a member of
 * (or null when they have no memberships / none matched).
 *
 * Returns one repair per violating user: drop the dangling default in favour
 * of the user's first membership, or null when they have no memberships left.
 */
export function computeDefaultCompanyRepairs(
  users: { id: string; defaultCompanyId: string | null }[],
  memberships: { userId: string; companyId: string }[],
): { userId: string; defaultCompanyId: string | null }[] {
  const companyIdsByUser = new Map<string, string[]>();
  for (const m of memberships) {
    const list = companyIdsByUser.get(m.userId) ?? [];
    list.push(m.companyId);
    companyIdsByUser.set(m.userId, list);
  }
  const repairs: { userId: string; defaultCompanyId: string | null }[] = [];
  for (const user of users) {
    if (!user.defaultCompanyId) continue; // null is always consistent
    const ids = companyIdsByUser.get(user.id) ?? [];
    if (!ids.includes(user.defaultCompanyId)) {
      repairs.push({ userId: user.id, defaultCompanyId: ids[0] ?? null });
    }
  }
  return repairs;
}

/**
 * Company CRUD. Creating a company also grants the creating user membership
 * (UserCompany) and makes it their default company when they had none —
 * a user can only bootstrap a tenant they belong to.
 *
 * Mini-Gate: UserCompany has NO isDefault column — users.default_company_id
 * is the single canonical source of the default company.
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(): Promise<Company[]> {
    return this.prisma.company.findMany({ orderBy: { createdAt: 'asc' } });
  }

  async getById(id: string): Promise<Company> {
    const company = await this.prisma.company.findUnique({ where: { id } });
    if (!company) throw new NotFoundError('Company not found', { id });
    return company;
  }

  async create(
    dto: CreateCompanyDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Company> {
    const company = await this.prisma.$transaction(async (trx) => {
      const created = await trx.company.create({
        data: {
          nameFa: dto.nameFa,
          nameEn: dto.nameEn,
          nationalId: dto.nationalId,
          economicCode: dto.economicCode,
        },
      });
      // Grant the creating user membership; default only if they had none.
      const user = await trx.user.findUnique({
        where: { id: actor.id },
        select: { defaultCompanyId: true },
      });
      await trx.userCompany.create({
        data: {
          userId: actor.id,
          companyId: created.id,
        },
      });
      if (!user?.defaultCompanyId) {
        await trx.user.update({
          where: { id: actor.id },
          data: { defaultCompanyId: created.id },
        });
      }
      return created;
    });

    await this.auditService.record({
      entityType: 'company',
      entityId: company.id,
      action: AuditAction.CREATE,
      actor,
      companyId: company.id,
      newValues: { nameFa: company.nameFa, nameEn: company.nameEn },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return company;
  }

  async update(
    id: string,
    dto: UpdateCompanyDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Company> {
    const existing = await this.getById(id);
    const updated = await this.prisma.company.update({
      where: { id },
      data: {
        nameFa: dto.nameFa,
        nameEn: dto.nameEn,
        nationalId: dto.nationalId,
        economicCode: dto.economicCode,
      },
    });
    await this.auditService.record({
      entityType: 'company',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      companyId: id,
      oldValues: { nameFa: existing.nameFa, nameEn: existing.nameEn, nationalId: existing.nationalId, economicCode: existing.economicCode },
      newValues: { nameFa: updated.nameFa, nameEn: updated.nameEn, nationalId: updated.nationalId, economicCode: updated.economicCode },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  /**
   * Mini-Gate #3 (mini-03): repair users whose defaultCompanyId points at a
   * company they are NOT a member of (e.g. after membership deletion). Runs
   * inside the passed transaction client when given; returns the number of
   * repaired rows.
   */
  async ensureDefaultCompanyIntegrity(
    tx?: Pick<Prisma.TransactionClient, 'user' | 'userCompany'>,
  ): Promise<number> {
    const client = tx ?? this.prisma;
    const [users, memberships] = await Promise.all([
      client.user.findMany({
        where: { defaultCompanyId: { not: null } },
        select: { id: true, defaultCompanyId: true },
      }),
      client.userCompany.findMany({ select: { userId: true, companyId: true } }),
    ]);
    const repairs = computeDefaultCompanyRepairs(users, memberships);
    for (const repair of repairs) {
      await client.user.update({
        where: { id: repair.userId },
        data: { defaultCompanyId: repair.defaultCompanyId },
      });
    }
    return repairs.length;
  }

  async remove(id: string, actor: { id: string; username: string }, ctx: RequestContext): Promise<void> {    const existing = await this.getById(id);
    try {
      await this.prisma.company.delete({ where: { id } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ConflictError('Company still has dependent records and cannot be deleted', { id });
      }
      throw error;
    }
    await this.auditService.record({
      entityType: 'company',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      companyId: null,
      oldValues: { nameFa: existing.nameFa, nameEn: existing.nameEn },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }
}
