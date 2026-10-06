import { Injectable } from '@nestjs/common';
import { Prisma, SupplierMappingLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { NotFoundError, ValidationError } from '../common/errors';
import { Paginated } from '../common/dto/pagination.dto';
import {
  CreateSupplierMappingDto,
  SupplierMappingQueryDto,
  UpdateSupplierMappingDto,
} from './products.dto';

export const NOT_A_SUPPLIER = 'NOT_A_SUPPLIER';

interface LevelInput {
  supplierPartyId: string;
  mappingLevel: SupplierMappingLevel;
  productVariantId?: string | null;
  productTemplateId?: string | null;
  categoryId?: string | null;
}

/**
 * p3b-14 — service-level mirror of the supplier_products_exactly_one_level_chk
 * CHECK: the mapping level must match EXACTLY ONE target FK (no more, no less,
 * no other FKs set). Pure + static so it is unit-testable without a DB.
 */
export function assertExactlyOneLevel(input: LevelInput): void {
  const variant = input.productVariantId ?? null;
  const template = input.productTemplateId ?? null;
  const category = input.categoryId ?? null;
  const setCount = [variant, template, category].filter(Boolean).length;
  const expected =
    input.mappingLevel === 'VARIANT'
      ? variant
      : input.mappingLevel === 'TEMPLATE'
        ? template
        : category;
  if (setCount !== 1 || !expected) {
    throw new ValidationError('SUPPLIER_MAPPING_EXACTLY_ONE_LEVEL', {
      mappingLevel: input.mappingLevel,
      productVariantId: variant,
      productTemplateId: template,
      categoryId: category,
    });
  }
}

@Injectable()
export class SupplierMappingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static wrapCheckViolation(error: unknown): never {
    if (
      error instanceof Error &&
      (error.message.includes('supplier_products_exactly_one_level_chk') ||
        (error as { code?: string }).code === 'P2010')
    ) {
      throw new ValidationError('SUPPLIER_MAPPING_EXACTLY_ONE_LEVEL');
    }
    throw error as Error;
  }

  /** p3b-13 — the party must exist in the company AND hold the SUPPLIER role. */
  private async assertSupplier(companyId: string, supplierPartyId: string) {
    const party = await this.prisma.party.findUnique({
      where: { id: supplierPartyId },
      select: {
        id: true,
        companyId: true,
        roles: { select: { role: true } },
      },
    });
    if (!party || party.companyId !== companyId) {
      throw new ValidationError('Supplier party not found in this company', {
        supplierPartyId,
      });
    }
    if (!party.roles.some((r) => r.role === 'SUPPLIER')) {
      throw new ValidationError(NOT_A_SUPPLIER, { supplierPartyId });
    }
  }

  /** FK targets must belong to the same company. */
  private async assertTargets(
    companyId: string,
    input: { productVariantId?: string | null; productTemplateId?: string | null; categoryId?: string | null },
  ) {
    if (input.productVariantId) {
      const row = await this.prisma.productVariant.findUnique({
        where: { id: input.productVariantId },
        select: { companyId: true },
      });
      if (!row || row.companyId !== companyId) {
        throw new ValidationError('Product variant not found in this company', {
          productVariantId: input.productVariantId,
        });
      }
    }
    if (input.productTemplateId) {
      const row = await this.prisma.productTemplate.findUnique({
        where: { id: input.productTemplateId },
        select: { companyId: true },
      });
      if (!row || row.companyId !== companyId) {
        throw new ValidationError('Product template not found in this company', {
          productTemplateId: input.productTemplateId,
        });
      }
    }
    if (input.categoryId) {
      const row = await this.prisma.productCategory.findUnique({
        where: { id: input.categoryId },
        select: { companyId: true },
      });
      if (!row || row.companyId !== companyId) {
        throw new ValidationError('Product category not found in this company', {
          categoryId: input.categoryId,
        });
      }
    }
  }

  async create(
    companyId: string,
    dto: CreateSupplierMappingDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    assertExactlyOneLevel(dto);
    await this.assertSupplier(companyId, dto.supplierPartyId);
    await this.assertTargets(companyId, dto);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.supplierProduct.create({
          data: {
            companyId,
            supplierPartyId: dto.supplierPartyId,
            mappingLevel: dto.mappingLevel,
            productVariantId: dto.productVariantId,
            productTemplateId: dto.productTemplateId,
            categoryId: dto.categoryId,
            supplierProductCode: dto.supplierProductCode,
            supplierProductName: dto.supplierProductName,
            notes: dto.notes,
            isActive: dto.isActive ?? true,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'supplier_product',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: {
            supplierPartyId: row.supplierPartyId,
            mappingLevel: row.mappingLevel,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      SupplierMappingsService.wrapCheckViolation(error);
    }
  }

  async list(companyId: string, query: SupplierMappingQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.SupplierProductWhereInput = {
      companyId,
      ...(query.supplierPartyId ? { supplierPartyId: query.supplierPartyId } : {}),
      ...(query.mappingLevel ? { mappingLevel: query.mappingLevel } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.supplierProduct.findMany({
        where,
        select: {
          id: true,
          supplierPartyId: true,
          supplierParty: { select: { id: true, nameFa: true } },
          mappingLevel: true,
          productVariantId: true,
          productVariant: { select: { id: true, sku: true, nameFa: true } },
          productTemplateId: true,
          productTemplate: { select: { id: true, nameFa: true, internalCode: true } },
          categoryId: true,
          category: { select: { id: true, nameFa: true } },
          supplierProductCode: true,
          supplierProductName: true,
          notes: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.supplierProduct.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateSupplierMappingDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.supplierProduct.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Supplier mapping not found', { id });
    }
    const merged: LevelInput = {
      supplierPartyId: dto.supplierPartyId ?? existing.supplierPartyId,
      mappingLevel: dto.mappingLevel ?? existing.mappingLevel,
      productVariantId:
        dto.productVariantId !== undefined
          ? dto.productVariantId
          : existing.productVariantId,
      productTemplateId:
        dto.productTemplateId !== undefined
          ? dto.productTemplateId
          : existing.productTemplateId,
      categoryId: dto.categoryId !== undefined ? dto.categoryId : existing.categoryId,
    };
    assertExactlyOneLevel(merged);
    await this.assertSupplier(companyId, merged.supplierPartyId);
    await this.assertTargets(companyId, merged);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.supplierProduct.update({
          where: { id },
          data: {
            supplierPartyId: merged.supplierPartyId,
            mappingLevel: merged.mappingLevel,
            productVariantId: merged.productVariantId,
            productTemplateId: merged.productTemplateId,
            categoryId: merged.categoryId,
            ...(dto.supplierProductCode !== undefined
              ? { supplierProductCode: dto.supplierProductCode }
              : {}),
            ...(dto.supplierProductName !== undefined
              ? { supplierProductName: dto.supplierProductName }
              : {}),
            ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
            ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'supplier_product',
          entityId: id,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: { mappingLevel: existing.mappingLevel, isActive: existing.isActive },
          newValues: { mappingLevel: updated.mappingLevel, isActive: updated.isActive },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    } catch (error) {
      SupplierMappingsService.wrapCheckViolation(error);
    }
  }
}
