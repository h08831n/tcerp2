import { Injectable } from '@nestjs/common';
import { Prisma, Company } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreateCompanyDto, UpdateCompanyDto } from './companies.dto';

/**
 * Company CRUD. Creating a company also grants the creating user membership
 * (UserCompany) and makes it their default company when they had none —
 * a user can only bootstrap a tenant they belong to.
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
      const hasDefault = await trx.userCompany.findFirst({
        where: { userId: actor.id, isDefault: true },
      });
      await trx.userCompany.create({
        data: {
          userId: actor.id,
          companyId: created.id,
          isDefault: !hasDefault,
        },
      });
      if (!hasDefault) {
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

  async remove(id: string, actor: { id: string; username: string }, ctx: RequestContext): Promise<void> {
    const existing = await this.getById(id);
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
