import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateUomCategoryDto,
  CreateUomDto,
  UpdateUomCategoryDto,
  UpdateUomDto,
} from './products.dto';

/** Stable code for the exactly-one-base-unit-per-category business rule. */
export const UOM_BASE_UNIT_EXISTS = 'UOM_BASE_UNIT_EXISTS';

@Injectable()
export class UomsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static wrapKnown(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === 'P2002') {
        const target = error.meta?.target as string[] | undefined;
        if (target?.includes('symbol')) {
          throw new ConflictError('UOM symbol already exists in this company');
        }
        throw new ConflictError('UOM category code already exists in this company');
      }
      // The DB partial unique uoms_base_unit_uniq is the backstop for the
      // exactly-one-base rule; map the violation onto the stable domain code.
      if (error.code === 'P2010' || error.message.includes('uoms_base_unit_uniq')) {
        throw new ConflictError(UOM_BASE_UNIT_EXISTS);
      }
    }
    throw error as Error;
  }

  // ───────────────────────── uom categories ─────────────────────────

  async createCategory(
    companyId: string,
    dto: CreateUomCategoryDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.uomCategory.create({
          data: {
            companyId,
            code: dto.code,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'uom_category',
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
      UomsService.wrapKnown(error);
    }
  }

  async listCategories(companyId: string) {
    return this.prisma.uomCategory.findMany({
      where: { companyId },
      orderBy: { nameFa: 'asc' },
      include: { uoms: { orderBy: [{ isBaseUnit: 'desc' }, { nameFa: 'asc' }] } },
    });
  }

  async updateCategory(
    companyId: string,
    id: string,
    dto: UpdateUomCategoryDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.uomCategory.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('UOM category not found', { id });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.uomCategory.update({
        where: { id },
        data: {
          ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
          ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'uom_category',
        entityId: id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { nameFa: existing.nameFa },
        newValues: { nameFa: updated.nameFa },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }

  // ───────────────────────── uoms ─────────────────────────

  private async assertBaseUnitAvailable(
    categoryId: string,
    excludeUomId?: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ) {
    const existingBase = await client.uom.findFirst({
      where: {
        categoryId,
        isBaseUnit: true,
        ...(excludeUomId ? { id: { not: excludeUomId } } : {}),
      },
      select: { id: true, symbol: true },
    });
    if (existingBase) {
      throw new ConflictError(UOM_BASE_UNIT_EXISTS, {
        categoryId,
        existingBaseUomId: existingBase.id,
      });
    }
  }

  async createUom(
    companyId: string,
    dto: CreateUomDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const category = await this.prisma.uomCategory.findUnique({
      where: { id: dto.categoryId },
      select: { id: true, companyId: true },
    });
    if (!category || category.companyId !== companyId) {
      throw new ValidationError('UOM category not found in this company', {
        categoryId: dto.categoryId,
      });
    }
    if (dto.isBaseUnit) {
      await this.assertBaseUnitAvailable(dto.categoryId);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.uom.create({
          data: {
            companyId,
            categoryId: dto.categoryId,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            symbol: dto.symbol,
            conversionRatio: new Prisma.Decimal(dto.conversionRatio),
            isBaseUnit: dto.isBaseUnit ?? false,
            active: dto.active ?? true,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'uom',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: {
            symbol: row.symbol,
            conversionRatio: row.conversionRatio,
            isBaseUnit: row.isBaseUnit,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      UomsService.wrapKnown(error);
    }
  }

  async listUoms(
    companyId: string,
    filters: { categoryId?: string; active?: boolean },
  ): Promise<Paginated<unknown>> {
    const where: Prisma.UomWhereInput = {
      companyId,
      ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
      ...(filters.active !== undefined ? { active: filters.active } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.uom.findMany({
        where,
        select: {
          id: true,
          categoryId: true,
          category: { select: { id: true, nameFa: true, code: true } },
          nameFa: true,
          nameEn: true,
          symbol: true,
          conversionRatio: true,
          isBaseUnit: true,
          active: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: [{ categoryId: 'asc' }, { conversionRatio: 'asc' }],
      }),
      this.prisma.uom.count({ where }),
    ]);
    // listUoms is a small reference list — page envelope kept for symmetry.
    return {
      items,
      total,
      page: 1,
      pageSize: Math.max(total, 1),
    };
  }

  async updateUom(
    companyId: string,
    id: string,
    dto: UpdateUomDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.uom.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('UOM not found', { id });
    }
    if (dto.isBaseUnit) {
      await this.assertBaseUnitAvailable(existing.categoryId, id);
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.uom.update({
          where: { id },
          data: {
            ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
            ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
            ...(dto.conversionRatio !== undefined
              ? { conversionRatio: new Prisma.Decimal(dto.conversionRatio) }
              : {}),
            ...(dto.isBaseUnit !== undefined ? { isBaseUnit: dto.isBaseUnit } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'uom',
          entityId: id,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: {
            conversionRatio: existing.conversionRatio,
            isBaseUnit: existing.isBaseUnit,
            active: existing.active,
          },
          newValues: {
            conversionRatio: updated.conversionRatio,
            isBaseUnit: updated.isBaseUnit,
            active: updated.active,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    } catch (error) {
      UomsService.wrapKnown(error);
    }
  }
}
