import { Injectable } from '@nestjs/common';
import { SupplierProduct, SupplierMappingLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

export interface SupplierProductInput {
  supplierPartyId: string;
  mappingLevel: SupplierMappingLevel;
  productVariantId?: string | null;
  productTemplateId?: string | null;
  categoryId?: string | null;
  supplierProductCode?: string;
  isActive?: boolean;
}

/**
 * Supplier ↔ product mapping. The mapping is genuinely three-level: the
 * mapping level must match EXACTLY ONE foreign key (also enforced by the
 * supplier_products_exactly_one_level_chk CHECK — P2010/raw violations map to
 * ValidationError).
 */
@Injectable()
export class SupplierProductService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /** Service-level mirror of the DB CHECK. */
  static assertExactlyOne(input: SupplierProductInput): void {
    const variant = input.productVariantId ?? null;
    const template = input.productTemplateId ?? null;
    const category = input.categoryId ?? null;
    const set = [variant, template, category].filter(Boolean).length;
    if (input.mappingLevel === 'VARIANT' && (set !== 1 || !variant)) {
      throw new ValidationError(
        'VARIANT mapping requires exactly productVariantId (and no other FK)',
      );
    }
    if (input.mappingLevel === 'TEMPLATE' && (set !== 1 || !template)) {
      throw new ValidationError(
        'TEMPLATE mapping requires exactly productTemplateId (and no other FK)',
      );
    }
    if (input.mappingLevel === 'CATEGORY' && (set !== 1 || !category)) {
      throw new ValidationError(
        'CATEGORY mapping requires exactly categoryId (and no other FK)',
      );
    }
  }

  private static wrapCheckViolation(error: unknown): never {
    // P2010 = raw-query/CHECK pipeline rejection; P2003-ish CHECK failures
    // surface as PrismaClientKnownRequestError from the DB.
    if (
      error instanceof Error &&
      (error.message.includes('supplier_products_exactly_one_level_chk') ||
        (error as { code?: string }).code === 'P2010')
    ) {
      throw new ValidationError('Supplier product mapping violates the exactly-one rule');
    }
    throw error as Error;
  }

  async create(
    companyId: string,
    input: SupplierProductInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<SupplierProduct> {
    SupplierProductService.assertExactlyOne(input);
    try {
      const created = await this.prisma.supplierProduct.create({
        data: {
          companyId,
          supplierPartyId: input.supplierPartyId,
          mappingLevel: input.mappingLevel,
          productVariantId: input.productVariantId ?? null,
          productTemplateId: input.productTemplateId ?? null,
          categoryId: input.categoryId ?? null,
          supplierProductCode: input.supplierProductCode,
          isActive: input.isActive ?? true,
        },
      });
      await this.auditService.record({
        entityType: 'supplier_product',
        entityId: created.id,
        action: AuditAction.CREATE,
        actor,
        companyId,
        newValues: {
          supplierPartyId: created.supplierPartyId,
          mappingLevel: created.mappingLevel,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return created;
    } catch (error) {
      SupplierProductService.wrapCheckViolation(error);
    }
  }

  async update(
    companyId: string,
    id: string,
    input: SupplierProductInput,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<SupplierProduct> {
    const existing = await this.prisma.supplierProduct.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new ValidationError('Supplier product mapping not found', { id });
    }
    SupplierProductService.assertExactlyOne(input);
    try {
      const updated = await this.prisma.supplierProduct.update({
        where: { id: existing.id },
        data: {
          supplierPartyId: input.supplierPartyId,
          mappingLevel: input.mappingLevel,
          productVariantId: input.productVariantId ?? null,
          productTemplateId: input.productTemplateId ?? null,
          categoryId: input.categoryId ?? null,
          supplierProductCode: input.supplierProductCode,
          isActive: input.isActive,
        },
      });
      await this.auditService.record({
        entityType: 'supplier_product',
        entityId: id,
        action: AuditAction.UPDATE,
        actor,
        companyId,
        oldValues: { mappingLevel: existing.mappingLevel },
        newValues: { mappingLevel: updated.mappingLevel },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    } catch (error) {
      SupplierProductService.wrapCheckViolation(error);
    }
  }

  async list(companyId: string, supplierPartyId?: string): Promise<SupplierProduct[]> {
    return this.prisma.supplierProduct.findMany({
      where: { companyId, supplierPartyId },
      orderBy: { createdAt: 'asc' },
    });
  }
}
