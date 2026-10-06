import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { Paginated } from '../common/dto/pagination.dto';
import { BrandQueryDto, CreateBrandDto, UpdateBrandDto } from './products.dto';

@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static wrapUnique(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictError('Brand code already exists in this company');
    }
    throw error as Error;
  }

  private async assertLogo(companyId: string, logoAttachmentId: string | null | undefined) {
    if (!logoAttachmentId) return;
    const file = await this.prisma.fileAttachment.findUnique({
      where: { id: logoAttachmentId },
      select: { id: true, companyId: true },
    });
    if (!file || file.companyId !== companyId) {
      throw new ValidationError('Logo attachment not found in this company', {
        logoAttachmentId,
      });
    }
  }

  async create(
    companyId: string,
    dto: CreateBrandDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.assertLogo(companyId, dto.logoAttachmentId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.brand.create({
          data: {
            companyId,
            code: dto.code,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            logoAttachmentId: dto.logoAttachmentId,
            active: dto.active ?? true,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'brand',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { code: row.code, nameFa: row.nameFa },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      BrandsService.wrapUnique(error);
    }
  }

  async list(companyId: string, query: BrandQueryDto): Promise<Paginated<unknown>> {
    const active =
      query.active === 'any' ? undefined : query.active === 'false' ? false : true;
    const where: Prisma.BrandWhereInput = {
      companyId,
      ...(active !== undefined ? { active } : {}),
      ...(query.search
        ? {
            OR: [
              { nameFa: { contains: query.search.trim(), mode: 'insensitive' as const } },
              { nameEn: { contains: query.search.trim(), mode: 'insensitive' as const } },
              { code: { contains: query.search.trim(), mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.brand.findMany({
        where,
        select: {
          id: true,
          code: true,
          nameFa: true,
          nameEn: true,
          logoAttachmentId: true,
          active: true,
          version: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { nameFa: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.brand.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(companyId: string, id: string) {
    const row = await this.prisma.brand.findUnique({ where: { id } });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundError('Brand not found', { id });
    }
    return row;
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateBrandDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.brand.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Brand not found', { id });
    }
    await this.assertLogo(companyId, dto.logoAttachmentId);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.brand.update({
        where: { id },
        data: {
          ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
          ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
          ...(dto.logoAttachmentId !== undefined
            ? { logoAttachmentId: dto.logoAttachmentId }
            : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'brand',
        entityId: id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { nameFa: existing.nameFa, active: existing.active },
        newValues: { nameFa: updated.nameFa, active: updated.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }
}
