import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { RequestContext } from '../auth/auth.service';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { Paginated } from '../common/dto/pagination.dto';
import {
  AddTemplateAttributeDto,
  CreateTemplateDto,
  GenerateVariantsDto,
  PreviewSelectionDto,
  PreviewVariantsDto,
  TemplateQueryDto,
  UpdateTemplateAttributeDto,
  UpdateTemplateDto,
} from './products.dto';

type Client = PrismaService | Prisma.TransactionClient;

export const VERSION_CONFLICT = 'VERSION_CONFLICT';

// ───────────────── pure variant helpers (unit-testable) ─────────────────

export interface SelectionPair {
  attributeId: string;
  valueId: string;
}

/**
 * p3b-07 — full cartesian product of the selections, attribute order kept,
 * value order as given. Deterministic across calls (stable input → stable
 * output; no randomness, no Map iteration order surprises — plain arrays).
 */
export function cartesianProduct(
  selections: PreviewSelectionDto[],
): SelectionPair[][] {
  let acc: SelectionPair[][] = [[]];
  for (const selection of selections) {
    const next: SelectionPair[][] = [];
    for (const combo of acc) {
      for (const valueId of selection.valueIds) {
        next.push([...combo, { attributeId: selection.attributeId, valueId }]);
      }
    }
    acc = next;
  }
  return acc;
}

/** Stable identity key for a combination: sorted attributeId:valueId pairs. */
export function combinationKey(selections: SelectionPair[]): string {
  return [...selections]
    .map((s) => `${s.attributeId}:${s.valueId}`)
    .sort()
    .join('|');
}

/** p3b-09 — SKU auto-suffix ladder: base, base-2, base-3 … ConflictError after. */
export function skuCandidates(baseSku: string, suffixLimit = 3): string[] {
  const out = [baseSku];
  for (let n = 2; n <= suffixLimit; n += 1) out.push(`${baseSku}-${n}`);
  return out;
}

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private static wrapUnique(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictError('Template internal code already exists in this company');
    }
    throw error as Error;
  }

  private static wrapVersionConflict(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2025'
    ) {
      throw new ConflictError(VERSION_CONFLICT);
    }
    throw error as Error;
  }

  // ───────────────────── FK validation helpers ─────────────────────

  private async assertCategory(companyId: string, categoryId: string) {
    const category = await this.prisma.productCategory.findUnique({
      where: { id: categoryId },
      select: { id: true, companyId: true, active: true },
    });
    if (!category || category.companyId !== companyId) {
      throw new ValidationError('Category not found in this company', { categoryId });
    }
    if (!category.active) {
      throw new ValidationError('Category is archived', { categoryId });
    }
    return category;
  }

  private async assertSameCompany(
    model: 'brand' | 'uom' | 'taxDefinition' | 'attribute',
    companyId: string,
    id?: string | null,
  ) {
    if (!id) return;
    const row =
      model === 'brand'
        ? await this.prisma.brand.findUnique({ where: { id }, select: { id: true, companyId: true } })
        : model === 'uom'
          ? await this.prisma.uom.findUnique({ where: { id }, select: { id: true, companyId: true } })
          : model === 'attribute'
            ? await this.prisma.attribute.findUnique({ where: { id }, select: { id: true, companyId: true } })
            : await this.prisma.taxDefinition.findUnique({ where: { id }, select: { id: true, companyId: true } });
    if (!row || row.companyId !== companyId) {
      throw new ValidationError(`${model} not found in this company`, { [model]: id });
    }
  }

  // ───────────────────── CRUD ─────────────────────

  async create(
    companyId: string,
    dto: CreateTemplateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.assertCategory(companyId, dto.categoryId);
    await this.assertSameCompany('brand', companyId, dto.brandId);
    await this.assertSameCompany('uom', companyId, dto.defaultSalesUomId);
    await this.assertSameCompany('uom', companyId, dto.defaultPurchaseUomId);
    await this.assertSameCompany('taxDefinition', companyId, dto.defaultTaxDefinitionId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.productTemplate.create({
          data: {
            companyId,
            categoryId: dto.categoryId,
            brandId: dto.brandId,
            nameFa: dto.nameFa,
            nameEn: dto.nameEn,
            internalCode: dto.internalCode,
            description: dto.description,
            productType: dto.productType ?? 'STORABLE',
            isSellable: dto.isSellable ?? true,
            isPurchasable: dto.isPurchasable ?? true,
            defaultSalesUomId: dto.defaultSalesUomId,
            defaultPurchaseUomId: dto.defaultPurchaseUomId,
            defaultSalesPrice:
              dto.defaultSalesPrice !== undefined
                ? new Prisma.Decimal(dto.defaultSalesPrice)
                : undefined,
            defaultTaxDefinitionId: dto.defaultTaxDefinitionId,
            createdBy: actor.id,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'product_template',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { nameFa: row.nameFa, internalCode: row.internalCode },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      TemplatesService.wrapUnique(error);
    }
  }

  /**
   * p3b-15 — list projection: page of templates in at most 3 queries
   * (findMany + count + one groupBy for variantsCount) — no N+1.
   * Search hits name_fa (the pg_trgm GIN index accelerates the ilike),
   * name_en and internal_code.
   */
  async list(companyId: string, query: TemplateQueryDto): Promise<Paginated<unknown>> {
    const active =
      query.active === 'any' ? undefined : query.active === 'false' ? false : true;
    const where: Prisma.ProductTemplateWhereInput = {
      companyId,
      ...(active !== undefined ? { active } : {}),
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.productType ? { productType: query.productType } : {}),
      ...(query.search
        ? {
            OR: [
              { nameFa: { contains: query.search.trim(), mode: 'insensitive' as const } },
              { nameEn: { contains: query.search.trim(), mode: 'insensitive' as const } },
              { internalCode: { contains: query.search.trim(), mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total, variantCounts] = await Promise.all([
      this.prisma.productTemplate.findMany({
        where,
        select: {
          id: true,
          nameFa: true,
          nameEn: true,
          internalCode: true,
          category: { select: { id: true, nameFa: true } },
          brand: { select: { id: true, nameFa: true } },
          productType: true,
          active: true,
          version: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.productTemplate.count({ where }),
      this.prisma.productVariant.groupBy({
        by: ['templateId'],
        where: { companyId, active: true },
        _count: { _all: true },
      }),
    ]);

    const countByTemplate = new Map(
      variantCounts.map((c) => [c.templateId, c._count._all]),
    );
    const items = rows.map((row) => ({ ...row, variantsCount: countByTemplate.get(row.id) ?? 0 }));
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  /** Full detail: ordered attributes (+values), variants (+values), UOM summaries. */
  async getById(companyId: string, id: string) {
    const row = await this.prisma.productTemplate.findUnique({
      where: { id },
      include: {
        category: { select: { id: true, nameFa: true, nameEn: true, code: true } },
        brand: { select: { id: true, nameFa: true, nameEn: true, code: true } },
        salesUom: { select: { id: true, nameFa: true, symbol: true } },
        purchaseUom: { select: { id: true, nameFa: true, symbol: true } },
        taxDefinition: { select: { id: true, name: true } },
        attributes: {
          orderBy: [{ displayOrder: 'asc' }, { attributeId: 'asc' }],
          include: {
            attribute: {
              include: {
                values: {
                  where: { active: true },
                  orderBy: [{ displayOrder: 'asc' }, { valueFa: 'asc' }],
                },
              },
            },
          },
        },
        variants: {
          orderBy: { createdAt: 'asc' },
          include: {
            defaultUom: { select: { id: true, nameFa: true, symbol: true } },
            values: {
              include: {
                attributeValue: {
                  select: { id: true, code: true, valueFa: true, valueEn: true },
                },
              },
            },
          },
        },
      },
    });
    if (!row || row.companyId !== companyId) {
      throw new NotFoundError('Template not found', { id });
    }
    return row;
  }

  /** p3b-16 — optimistic locking: PATCH with a stale version → VERSION_CONFLICT. */
  async update(
    companyId: string,
    id: string,
    dto: UpdateTemplateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.productTemplate.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Template not found', { id });
    }
    if (dto.categoryId) await this.assertCategory(companyId, dto.categoryId);
    if (dto.brandId) await this.assertSameCompany('brand', companyId, dto.brandId);
    if (dto.defaultSalesUomId)
      await this.assertSameCompany('uom', companyId, dto.defaultSalesUomId);
    if (dto.defaultPurchaseUomId)
      await this.assertSameCompany('uom', companyId, dto.defaultPurchaseUomId);
    if (dto.defaultTaxDefinitionId)
      await this.assertSameCompany('taxDefinition', companyId, dto.defaultTaxDefinitionId);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.productTemplate.update({
          // Optimistic lock: version must match or Prisma raises P2025.
          where: { id, version: dto.version },
          data: {
            ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
            ...(dto.brandId !== undefined ? { brandId: dto.brandId } : {}),
            ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
            ...(dto.nameEn !== undefined ? { nameEn: dto.nameEn } : {}),
            ...(dto.internalCode !== undefined ? { internalCode: dto.internalCode } : {}),
            ...(dto.description !== undefined ? { description: dto.description } : {}),
            ...(dto.productType !== undefined ? { productType: dto.productType } : {}),
            ...(dto.isSellable !== undefined ? { isSellable: dto.isSellable } : {}),
            ...(dto.isPurchasable !== undefined ? { isPurchasable: dto.isPurchasable } : {}),
            ...(dto.defaultSalesUomId !== undefined
              ? { defaultSalesUomId: dto.defaultSalesUomId }
              : {}),
            ...(dto.defaultPurchaseUomId !== undefined
              ? { defaultPurchaseUomId: dto.defaultPurchaseUomId }
              : {}),
            ...(dto.defaultSalesPrice !== undefined
              ? { defaultSalesPrice: new Prisma.Decimal(dto.defaultSalesPrice) }
              : {}),
            ...(dto.defaultTaxDefinitionId !== undefined
              ? { defaultTaxDefinitionId: dto.defaultTaxDefinitionId }
              : {}),
            version: { increment: 1 },
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'product_template',
          entityId: id,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: { nameFa: existing.nameFa, version: existing.version },
          newValues: { nameFa: updated.nameFa, version: updated.version },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    } catch (error) {
      TemplatesService.wrapVersionConflict(error);
      TemplatesService.wrapUnique(error);
    }
  }

  /** Soft archive (products.archive): active=false, version bumped, audited. */
  async archive(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const existing = await this.prisma.productTemplate.findUnique({ where: { id } });
    if (!existing || existing.companyId !== companyId) {
      throw new NotFoundError('Template not found', { id });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.productTemplate.update({
        where: { id },
        data: { active: false, version: { increment: 1 } },
      });
      await this.audit.recordTx(tx, {
        entityType: 'product_template',
        entityId: id,
        action: AuditAction.ARCHIVE,
        companyId,
        actor,
        oldValues: { active: existing.active },
        newValues: { active: updated.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }

  // ───────────────────── template attributes ─────────────────────

  private async assertTemplate(companyId: string, templateId: string) {
    const template = await this.prisma.productTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, companyId: true, internalCode: true, nameFa: true, active: true },
    });
    if (!template || template.companyId !== companyId) {
      throw new NotFoundError('Template not found', { templateId });
    }
    return template;
  }

  async addAttribute(
    companyId: string,
    templateId: string,
    dto: AddTemplateAttributeDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.assertTemplate(companyId, templateId);
    await this.assertSameCompany('attribute', companyId, dto.attributeId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.productTemplateAttribute.create({
          data: {
            templateId,
            attributeId: dto.attributeId,
            displayOrder: dto.displayOrder ?? 0,
            createsVariants: dto.createsVariants ?? true,
            isRequired: dto.isRequired ?? false,
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'product_template_attribute',
          entityId: row.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { templateId, attributeId: dto.attributeId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return row;
      });
    } catch (error) {
      TemplatesService.wrapUnique(error);
    }
  }

  async updateAttribute(
    companyId: string,
    templateId: string,
    attributeId: string,
    dto: UpdateTemplateAttributeDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.assertTemplate(companyId, templateId);
    const existing = await this.prisma.productTemplateAttribute.findUnique({
      where: { templateId_attributeId: { templateId, attributeId } },
    });
    if (!existing) {
      throw new NotFoundError('Template attribute not found', { templateId, attributeId });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.productTemplateAttribute.update({
        where: { id: existing.id },
        data: {
          ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
          ...(dto.createsVariants !== undefined
            ? { createsVariants: dto.createsVariants }
            : {}),
          ...(dto.isRequired !== undefined ? { isRequired: dto.isRequired } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'product_template_attribute',
        entityId: existing.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: {
          displayOrder: existing.displayOrder,
          createsVariants: existing.createsVariants,
        },
        newValues: {
          displayOrder: updated.displayOrder,
          createsVariants: updated.createsVariants,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }

  async removeAttribute(
    companyId: string,
    templateId: string,
    attributeId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    await this.assertTemplate(companyId, templateId);
    const existing = await this.prisma.productTemplateAttribute.findUnique({
      where: { templateId_attributeId: { templateId, attributeId } },
    });
    if (!existing) {
      throw new NotFoundError('Template attribute not found', { templateId, attributeId });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.productTemplateAttribute.delete({ where: { id: existing.id } });
      await this.audit.recordTx(tx, {
        entityType: 'product_template_attribute',
        entityId: existing.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { templateId, attributeId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { templateId, attributeId, removed: true };
    });
  }

  // ───────────────────── variant preview / generation ─────────────────────

  /** Variant-defining attributes (createsVariants) with their active values. */
  private async variantSpace(templateId: string) {
    return this.prisma.productTemplateAttribute.findMany({
      where: { templateId, createsVariants: true },
      orderBy: [{ displayOrder: 'asc' }, { attributeId: 'asc' }],
      include: {
        attribute: {
          select: {
            id: true,
            code: true,
            nameFa: true,
            values: {
              where: { active: true },
              orderBy: [{ displayOrder: 'asc' }, { valueFa: 'asc' }],
            },
          },
        },
      },
    });
  }

  /**
   * p3b-07 — preview: full cartesian product with SKU suggestions and
   * existsAlready markers. Restricted to the template's createsVariants
   * attributes. Deterministic for stable input.
   */
  async previewVariants(
    companyId: string,
    templateId: string,
    dto: PreviewVariantsDto,
  ) {
    const template = await this.assertTemplate(companyId, templateId);
    const space = await this.variantSpace(templateId);
    const variantAttributes = new Map(space.map((s) => [s.attributeId, s]));

    for (const selection of dto.selections) {
      if (!variantAttributes.has(selection.attributeId)) {
        throw new ValidationError('Attribute does not create variants on this template', {
          attributeId: selection.attributeId,
        });
      }
    }

    // Existing variants → combination keys, for existsAlready.
    const existingVariants = await this.prisma.productVariant.findMany({
      where: { templateId },
      select: { sku: true, values: { select: { attributeId: true, attributeValueId: true } } },
    });
    const existingKeys = new Set(
      existingVariants.map((v) =>
        combinationKey(
          v.values.map((x) => ({ attributeId: x.attributeId, valueId: x.attributeValueId })),
        ),
      ),
    );
    const existingSkus = new Set(existingVariants.map((v) => v.sku));

    const skuBase = template.internalCode ?? template.nameFa;
    const combos = cartesianProduct(dto.selections);

    // value lookup for codes + duplicate valueIds across selections
    const valueMeta = new Map<string, { code: string; attributeId: string }>();
    for (const s of space) {
      for (const v of s.attribute.values) {
        valueMeta.set(v.id, { code: v.code, attributeId: s.attributeId });
      }
    }

    return {
      combinations: combos.map((combo) => {
        const selection = combo.map((pair) => {
          const meta = valueMeta.get(pair.valueId);
          return {
            attributeId: pair.attributeId,
            attributeCode: variantAttributes.get(pair.attributeId)?.attribute.code ?? '',
            valueId: pair.valueId,
            valueCode: meta?.code ?? '',
          };
        });
        const skuSuggestion = [
          skuBase,
          ...selection.map((s) => s.valueCode),
        ].join('-');
        return {
          combination: selection,
          skuSuggestion,
          existsAlready:
            existingKeys.has(combinationKey(combo)) ||
            existingSkus.has(skuSuggestion),
        };
      }),
    };
  }

  /**
   * p3b-08/09 — generate the user-selected subset in ONE transaction.
   * Skip-with-report: an existing identical combination (same
   * attributeId→valueId set under the template) is skipped, never duplicated.
   * SKU collisions are auto-suffixed -2, -3; still colliding → ConflictError.
   * Existing variants are never mutated or deleted.
   */
  async generateVariants(
    companyId: string,
    templateId: string,
    dto: GenerateVariantsDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const template = await this.assertTemplate(companyId, templateId);
    const space = await this.variantSpace(templateId);
    const variantAttributes = new Map(space.map((s) => [s.attributeId, s]));
    const valueOwner = new Map<
      string,
      { attributeId: string; valueFa: string; code: string }
    >();
    for (const s of space) {
      for (const v of s.attribute.values) {
        valueOwner.set(v.id, {
          attributeId: s.attributeId,
          valueFa: v.valueFa,
          code: v.code,
        });
      }
    }
    const skuBase = template.internalCode ?? template.nameFa;

    return this.prisma.$transaction(async (tx) => {
      // Existing variants inside the tx → skip duplicates.
      const existingVariants = await tx.productVariant.findMany({
        where: { templateId },
        select: { sku: true, values: { select: { attributeId: true, attributeValueId: true } } },
      });
      const existingKeys = new Set(
        existingVariants.map((v) =>
          combinationKey(
            v.values.map((x) => ({ attributeId: x.attributeId, valueId: x.attributeValueId })),
          ),
        ),
      );
      const takenSkus = new Set(existingVariants.map((v) => v.sku));

      const created: Array<{ id: string; sku: string }> = [];
      const skipped: Array<{
        combination: SelectionPair[];
        reason: string;
      }> = [];

      for (const combination of dto.combinations) {
        const pairs = combination.selections;
        // Validate: each value belongs to a variant-defining attribute of the
        // template and every attribute appears at most once.
        const seenAttributes = new Set<string>();
        let invalid: string | null = null;
        for (const pair of pairs) {
          if (!variantAttributes.has(pair.attributeId)) {
            invalid = `Attribute ${pair.attributeId} does not create variants on this template`;
            break;
          }
          if (seenAttributes.has(pair.attributeId)) {
            invalid = `Duplicate attribute ${pair.attributeId} in combination`;
            break;
          }
          seenAttributes.add(pair.attributeId);
          const owner = valueOwner.get(pair.valueId);
          if (!owner || owner.attributeId !== pair.attributeId) {
            invalid = `Value ${pair.valueId} does not belong to attribute ${pair.attributeId}`;
            break;
          }
        }
        if (invalid) {
          skipped.push({ combination: pairs, reason: invalid });
          continue;
        }

        const key = combinationKey(pairs);
        if (existingKeys.has(key)) {
          skipped.push({ combination: pairs, reason: 'VARIANT_COMBINATION_EXISTS' });
          continue;
        }

        // SKU with auto-suffix ladder (codes, per the SKU convention).
        const baseSku = [skuBase, ...pairs.map((p) => valueOwner.get(p.valueId)?.code ?? p.valueId)]
          .join('-');
        let sku: string | null = null;
        for (const candidate of skuCandidates(baseSku)) {
          if (!takenSkus.has(candidate)) {
            sku = candidate;
            break;
          }
        }
        if (!sku) {
          throw new ConflictError('VARIANT_SKU_COLLISION', { baseSku });
        }

        const nameFa = `${template.nameFa} ${pairs
          .map((p) => valueOwner.get(p.valueId)?.valueFa ?? '')
          .join(' ')
          .trim()}`.trim();

        const variant = await tx.productVariant.create({
          data: {
            companyId,
            templateId,
            sku,
            nameFa,
            values: {
              create: pairs.map((p) => ({
                attributeId: p.attributeId,
                attributeValueId: p.valueId,
              })),
            },
          },
          select: { id: true, sku: true },
        });
        takenSkus.add(sku);
        existingKeys.add(key);
        created.push(variant);
        await this.audit.recordTx(tx, {
          entityType: 'product_variant',
          entityId: variant.id,
          action: AuditAction.CREATE,
          companyId,
          actor,
          newValues: { templateId, sku, combination: pairs },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }

      // One batch audit entry with the summary.
      await this.audit.recordTx(tx, {
        entityType: 'product_template',
        entityId: templateId,
        action: 'VARIANTS_GENERATED',
        companyId,
        actor,
        newValues: {
          createdCount: created.length,
          skippedCount: skipped.length,
          createdSkus: created.map((c) => c.sku),
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });

      return { created, skipped };
    });
  }

  /**
   * Phase-4 matrix: columns = first createsVariants attribute, rows = the
   * remaining ones, cells = existing variants keyed by their combination.
   */
  async matrix(companyId: string, templateId: string) {
    await this.assertTemplate(companyId, templateId);
    const space = await this.variantSpace(templateId);
    const columns = space.slice(0, 1).map((s) => ({
      attributeId: s.attributeId,
      nameFa: s.attribute.nameFa,
      values: s.attribute.values.map((v) => ({ id: v.id, code: v.code, valueFa: v.valueFa })),
    }));
    const rows = space.slice(1).map((s) => ({
      attributeId: s.attributeId,
      nameFa: s.attribute.nameFa,
      values: s.attribute.values.map((v) => ({ id: v.id, code: v.code, valueFa: v.valueFa })),
    }));

    const variants = await this.prisma.productVariant.findMany({
      where: { templateId },
      select: {
        id: true,
        sku: true,
        active: true,
        values: {
          select: { attributeId: true, attributeValueId: true },
          orderBy: { attributeValueId: 'asc' },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const cells = variants.map((v) => ({
      combination: v.values.map((x) => ({
        attributeId: x.attributeId,
        valueId: x.attributeValueId,
      })),
      variantId: v.id,
      sku: v.sku,
      active: v.active,
    }));

    return { columns, rows, cells };
  }
}
