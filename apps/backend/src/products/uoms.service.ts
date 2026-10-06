import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { assertSameCompany } from '../common/utils/entity-company';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateUomCategoryDto,
  CreateUomDto,
  UpdateUomCategoryDto,
  UpdateUomDto,
} from './products.dto';

/**
 * Stable domain codes for the base-unit rules (3B correction #4):
 *
 * - A category has AT MOST ONE base unit (partial unique
 *   `uoms_base_unit_uniq` is the DB backstop) — never "exactly one": a
 *   category may transiently have NO base, which blocks conversion inside
 *   it (UomConversionService → UOM_NO_BASE_UNIT) until a base exists.
 * - A base unit's ratio must be EXACTLY 1 (service rule +
 *   `uoms_base_ratio_one_chk` DB CHECK).
 * - Any UOM ratio must be > 0 (`uoms_conversion_ratio_positive_chk` DB
 *   CHECK; the service maps the violation onto UOM_RATIO_POSITIVE).
 * - Demoting the base (true → false) is allowed; promoting a second base
 *   (false → true while another base exists) → UOM_BASE_UNIT_EXISTS.
 */
export const UOM_BASE_UNIT_EXISTS = 'UOM_BASE_UNIT_EXISTS';
export const UOM_RATIO_POSITIVE = 'UOM_RATIO_POSITIVE';
export const UOM_BASE_RATIO_ONE = 'UOM_BASE_RATIO_ONE';

const RATIO_CHECK_CONSTRAINT = 'uoms_conversion_ratio_positive_chk';
const BASE_RATIO_CHECK_CONSTRAINT = 'uoms_base_ratio_one_chk';

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
      // at-most-one-base rule; map the violation onto the stable domain code.
      if (error.code === 'P2010' || error.message.includes('uoms_base_unit_uniq')) {
        throw new ConflictError(UOM_BASE_UNIT_EXISTS);
      }
    }
    // Postgres CHECK violations surface as PrismaClientUnknownRequestError
    // (23514) carrying the constraint name — map them onto stable codes
    // (3B correction #4).
    if (error instanceof Error) {
      if (error.message.includes(RATIO_CHECK_CONSTRAINT)) {
        throw new ValidationError(UOM_RATIO_POSITIVE);
      }
      if (error.message.includes(BASE_RATIO_CHECK_CONSTRAINT)) {
        throw new ValidationError(UOM_BASE_RATIO_ONE);
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
    // 3B correction #5 — shared same-company guard.
    assertSameCompany(companyId, category, 'UOM category not found in this company');
    // 3B correction #4 — a base unit's ratio must be exactly 1 (ratios are
    // defined relative to the base, so the base is its own reference).
    if (dto.isBaseUnit && !new Prisma.Decimal(dto.conversionRatio).eq(1)) {
      throw new ValidationError(UOM_BASE_RATIO_ONE, { conversionRatio: dto.conversionRatio });
    }
    if (dto.isBaseUnit) {
      await this.assertBaseUnitAvailable(dto.categoryId);
    }
    // Non-positive ratios are rejected by the DB CHECK
    // (uoms_conversion_ratio_positive_chk) and mapped by wrapKnown — no
    // service-side duplicate of the constraint.
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
    // Merged base state after the PATCH (3B correction #4): the ratio of a
    // unit that IS (or becomes) the base must be exactly 1. Demoting the
    // base (true → false) is allowed — the category may then transiently
    // have no base, which blocks conversion until a new one exists.
    const willBeBase = dto.isBaseUnit ?? existing.isBaseUnit;
    const newRatio =
      dto.conversionRatio !== undefined
        ? new Prisma.Decimal(dto.conversionRatio)
        : new Prisma.Decimal(existing.conversionRatio);
    if (willBeBase && !newRatio.eq(1)) {
      throw new ValidationError(UOM_BASE_RATIO_ONE, { conversionRatio: dto.conversionRatio });
    }
    if (dto.isBaseUnit) {
      // Promoting to base: only blocked while ANOTHER base exists.
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
