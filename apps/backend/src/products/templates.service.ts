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
  AddTemplateAttributeDto,
  CreateTemplateDto,
  GenerateVariantsDto,
  PreviewSelectionDto,
  PreviewVariantsDto,
  SetTemplateAttributeValuesDto,
  TemplateQueryDto,
  UpdateTemplateAttributeDto,
  UpdateTemplateAttributeValueDto,
  UpdateTemplateDto,
  UpdateVariantDto,
} from './products.dto';

type Client = PrismaService | Prisma.TransactionClient;

export const VERSION_CONFLICT = 'VERSION_CONFLICT';

/** Stable code for "this value is not part of the template's value universe". */
export const VALUE_NOT_AVAILABLE_FOR_TEMPLATE = 'VALUE_NOT_AVAILABLE_FOR_TEMPLATE';

// ───────────────── pure variant helpers (unit-testable) ─────────────────

export interface SelectionPair {
  attributeId: string;
  valueId: string;
}

export interface ValueMeta {
  id: string;
  code: string;
  valueFa: string;
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

/**
 * 3B correction #4 — canonical combination key for a variant combination.
 * Pure + deterministic: pairs sorted by attributeId THEN attributeValueId
 * (byte order, like the DB backfill `ORDER BY attribute_id, attribute_value_id`),
 * joined as `attributeId=attributeValueId` with `|`. Input order is
 * irrelevant; the DB unique (template_id, combination_key) is enforced on
 * exactly this format.
 */
export function buildCombinationKey(
  pairs: Array<{ attributeId: string; attributeValueId: string }>,
): string {
  return [...pairs]
    .map((p) => ({ a: p.attributeId, v: p.attributeValueId }))
    .sort((x, y) =>
      x.a < y.a ? -1 : x.a > y.a ? 1 : x.v < y.v ? -1 : x.v > y.v ? 1 : 0,
    )
    .map((p) => `${p.a}=${p.v}`)
    .join('|');
}

/**
 * @deprecated transitional alias kept for one release — identical output to
 * {@link buildCombinationKey} for the old `attributeId:valueId` consumers.
 */
export const combinationKey = (selections: SelectionPair[]): string =>
  buildCombinationKey(
    selections.map((s) => ({ attributeId: s.attributeId, attributeValueId: s.valueId })),
  );

/** p3b-09 — SKU auto-suffix ladder: base, base-2, base-3 … ConflictError after. */
export function skuCandidates(baseSku: string, suffixLimit = 3): string[] {
  const out = [baseSku];
  for (let n = 2; n <= suffixLimit; n += 1) out.push(`${baseSku}-${n}`);
  return out;
}

/** Canonical UOM category code for product weight (seed ensures one per company). */
export const WEIGHT_CATEGORY_CODE = 'WEIGHT';

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
      (error.code === 'P2025' || error.code === 'P2002')
    ) {
      if (error.code === 'P2002') {
        throw new ConflictError('Template internal code already exists in this company');
      }
      throw new ConflictError(VERSION_CONFLICT);
    }
    throw error as Error;
  }

  /**
   * 3B correction #4 — the DB unique (template_id, combination_key) is the
   * authority against duplicate variant combinations. A concurrent duplicate
   * that races past the in-transaction pre-check aborts the loser's whole
   * transaction with P2002 (a unique violation aborts the interactive
   * transaction, so per-row catch-and-continue is not possible) and is
   * mapped onto the stable domain codes here:
   *   - the combination-key target → VARIANT_COMBINATION_EXISTS;
   *   - otherwise, when a variant with one of the batch's combination keys
   *     already exists, the combination unique is the real story (Postgres
   *     merely reported the (company, sku) index first, and the SKU derives
   *     from the same combination) → VARIANT_COMBINATION_EXISTS;
   *   - otherwise the collision was purely on the SKU → VARIANT_SKU_COLLISION.
   */
  private async wrapGenerationConflict(
    error: unknown,
    templateId: string,
    batchKeys: string[],
  ): Promise<never> {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      if (TemplatesService.isCombinationKeyViolation(error)) {
        throw new ConflictError('VARIANT_COMBINATION_EXISTS');
      }
      const duplicateCombination = await this.prisma.productVariant.count({
        where: { templateId, combinationKey: { in: batchKeys } },
      });
      if (duplicateCombination > 0) {
        throw new ConflictError('VARIANT_COMBINATION_EXISTS');
      }
      throw new ConflictError('VARIANT_SKU_COLLISION');
    }
    throw error as Error;
  }

  /** Does this P2002 target the (template_id, combination_key) unique? */
  private static isCombinationKeyViolation(error: Prisma.PrismaClientKnownRequestError): boolean {
    const target = ((error.meta?.target as string[] | string | undefined) ?? []).toString();
    return (
      target.includes('combinationKey') ||
      target.includes('combination_key') ||
      error.message.includes('combination_key')
    );
  }

  private static wrapValueSelectionUnique(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictError('VALUE_ALREADY_SELECTED');
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

  private async assertSameCompanyRef(
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
    // 3B correction #5 — shared helper; same company or 422.
    assertSameCompany(companyId, row, `${model} not found in this company`);
  }

  /**
   * 3B correction #3 — weight UOM validation for the variant create / generate
   * / PATCH paths. When weightPerUnit is provided, weightUomId is REQUIRED;
   * the UOM must belong to the same company and its category must be the
   * company's Weight category, resolved canonically by the category CODE
   * 'WEIGHT' (seeded per company — the code, not the row id, is the contract).
   */
  private async assertWeightUomValid(companyId: string, weightUomId: string) {
    const uom = await this.prisma.uom.findUnique({
      where: { id: weightUomId },
      select: {
        id: true,
        companyId: true,
        category: { select: { companyId: true, code: true } },
      },
    });
    if (!uom || uom.companyId !== companyId || uom.category.companyId !== companyId) {
      throw new ValidationError('UOM_NOT_IN_COMPANY', { weightUomId });
    }
    if (uom.category.code !== WEIGHT_CATEGORY_CODE) {
      throw new ValidationError('WEIGHT_CATEGORY_REQUIRED', {
        weightUomId,
        categoryCode: uom.category.code,
      });
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
    await this.assertSameCompanyRef('brand', companyId, dto.brandId);
    await this.assertSameCompanyRef('uom', companyId, dto.defaultSalesUomId);
    await this.assertSameCompanyRef('uom', companyId, dto.defaultPurchaseUomId);
    await this.assertSameCompanyRef('taxDefinition', companyId, dto.defaultTaxDefinitionId);
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

  /** Full detail: ordered attributes (+selected values, +global values), variants, UOM summaries. */
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
                // Global active values — the picker universe to ADD selections from.
                values: {
                  where: { active: true },
                  orderBy: [{ displayOrder: 'asc' }, { valueFa: 'asc' }],
                },
              },
            },
            // 3B correction #2 — the template's SELECTED values per attribute.
            // While this list is empty the attribute falls back to the global
            // values above (transitional rule — see README).
            selectedValues: {
              where: { active: true },
              orderBy: [{ displayOrder: 'asc' }, { attributeValueId: 'asc' }],
              select: {
                id: true,
                attributeValueId: true,
                displayOrder: true,
                active: true,
                attributeValue: {
                  select: { id: true, code: true, valueFa: true, valueEn: true },
                },
              },
            },
          },
        },
        variants: {
          orderBy: { createdAt: 'asc' },
          include: {
            defaultUom: { select: { id: true, nameFa: true, symbol: true } },
            weightUom: { select: { id: true, nameFa: true, symbol: true } },
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
    if (dto.brandId) await this.assertSameCompanyRef('brand', companyId, dto.brandId);
    if (dto.defaultSalesUomId)
      await this.assertSameCompanyRef('uom', companyId, dto.defaultSalesUomId);
    if (dto.defaultPurchaseUomId)
      await this.assertSameCompanyRef('uom', companyId, dto.defaultPurchaseUomId);
    if (dto.defaultTaxDefinitionId)
      await this.assertSameCompanyRef('taxDefinition', companyId, dto.defaultTaxDefinitionId);

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
    await this.assertSameCompanyRef('attribute', companyId, dto.attributeId);
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

  // ──────────── selected values per template attribute (3B correction #2) ────────────

  private async assertTemplateAttribute(
    companyId: string,
    templateId: string,
    attributeId: string,
  ) {
    await this.assertTemplate(companyId, templateId);
    const row = await this.prisma.productTemplateAttribute.findUnique({
      where: { templateId_attributeId: { templateId, attributeId } },
    });
    if (!row) {
      throw new NotFoundError('Template attribute not found', { templateId, attributeId });
    }
    return row;
  }

  /**
   * The candidate AttributeValue must exist in the caller's company AND its
   * attribute_id must equal the ProductTemplateAttribute's attribute_id —
   * anything else is ATTRIBUTE_VALUE_MISMATCH (cross-company values are
   * invisible → 404 first, so foreign rows never leak).
   */
  private async assertSelectedValue(
    companyId: string,
    templateAttribute: { attributeId: string },
    valueId: string,
  ) {
    const value = await this.prisma.attributeValue.findUnique({
      where: { id: valueId },
      select: { id: true, attributeId: true, attribute: { select: { companyId: true } } },
    });
    if (!value || value.attribute.companyId !== companyId) {
      throw new NotFoundError('Attribute value not found', { valueId });
    }
    if (value.attributeId !== templateAttribute.attributeId) {
      throw new ValidationError('ATTRIBUTE_VALUE_MISMATCH', {
        valueId,
        attributeId: templateAttribute.attributeId,
      });
    }
    return value;
  }

  /**
   * POST /templates/:templateId/attributes/:attributeId/values
   * Two modes on one route: `{valueIds}` replaces the selected set (order is
   * kept as display order; an empty array clears the selection), `{valueId}`
   * adds one (idempotent). Audited inside the transaction.
   */
  async setTemplateAttributeValues(
    companyId: string,
    templateId: string,
    attributeId: string,
    dto: SetTemplateAttributeValuesDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const templateAttribute = await this.assertTemplateAttribute(
      companyId,
      templateId,
      attributeId,
    );
    const singleAdd = dto.valueId !== undefined;
    const replaceSet = dto.valueIds !== undefined;
    if (singleAdd === replaceSet) {
      throw new ValidationError('VALUE_SELECTION_MODE', {
        hint: 'Provide exactly one of valueIds (replace the set) or valueId (add a single value)',
      });
    }

    if (singleAdd) {
      const valueId = dto.valueId as string;
      await this.assertSelectedValue(companyId, templateAttribute, valueId);
      try {
        return await this.prisma.$transaction(async (tx) => {
          const existing = await tx.productTemplateAttributeValue.findUnique({
            where: {
              templateAttributeId_attributeValueId: {
                templateAttributeId: templateAttribute.id,
                attributeValueId: valueId,
              },
            },
          });
          if (existing) return existing; // idempotent add
          const maxRow = await tx.productTemplateAttributeValue.findFirst({
            where: { templateAttributeId: templateAttribute.id },
            orderBy: { displayOrder: 'desc' },
            select: { displayOrder: true },
          });
          const row = await tx.productTemplateAttributeValue.create({
            data: {
              templateAttributeId: templateAttribute.id,
              attributeValueId: valueId,
              displayOrder: (maxRow?.displayOrder ?? -1) + 1,
            },
          });
          await this.audit.recordTx(tx, {
            entityType: 'product_template_attribute_value',
            entityId: row.id,
            action: AuditAction.CREATE,
            companyId,
            actor,
            newValues: { templateId, attributeId, attributeValueId: valueId },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          return row;
        });
      } catch (error) {
        // A racing duplicate add aborts this tx (P2002) — the unique
        // (template_attribute_id, attribute_value_id) is the authority.
        TemplatesService.wrapValueSelectionUnique(error);
      }
    }

    // Replace mode — dedupe, validate every value, swap the set atomically.
    const valueIds = [...new Set(dto.valueIds as string[])];
    for (const valueId of valueIds) {
      await this.assertSelectedValue(companyId, templateAttribute, valueId);
    }
    return this.prisma.$transaction(async (tx) => {
      const previous = await tx.productTemplateAttributeValue.findMany({
        where: { templateAttributeId: templateAttribute.id },
        select: { attributeValueId: true },
        orderBy: [{ displayOrder: 'asc' }],
      });
      await tx.productTemplateAttributeValue.deleteMany({
        where: { templateAttributeId: templateAttribute.id },
      });
      if (valueIds.length > 0) {
        await tx.productTemplateAttributeValue.createMany({
          data: valueIds.map((attributeValueId, index) => ({
            templateAttributeId: templateAttribute.id,
            attributeValueId,
            displayOrder: index,
          })),
        });
      }
      await this.audit.recordTx(tx, {
        entityType: 'product_template_attribute_value',
        entityId: templateAttribute.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { templateId, attributeId, valueIds: previous.map((p) => p.attributeValueId) },
        newValues: { templateId, attributeId, valueIds },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return tx.productTemplateAttributeValue.findMany({
        where: { templateAttributeId: templateAttribute.id },
        orderBy: [{ displayOrder: 'asc' }],
      });
    });
  }

  /** PATCH displayOrder/active on one selected value. */
  async updateTemplateAttributeValue(
    companyId: string,
    templateId: string,
    attributeId: string,
    valueId: string,
    dto: UpdateTemplateAttributeValueDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const templateAttribute = await this.assertTemplateAttribute(
      companyId,
      templateId,
      attributeId,
    );
    const existing = await this.prisma.productTemplateAttributeValue.findUnique({
      where: {
        templateAttributeId_attributeValueId: {
          templateAttributeId: templateAttribute.id,
          attributeValueId: valueId,
        },
      },
    });
    if (!existing) {
      throw new NotFoundError('Template attribute value not found', { attributeId, valueId });
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.productTemplateAttributeValue.update({
        where: { id: existing.id },
        data: {
          ...(dto.displayOrder !== undefined ? { displayOrder: dto.displayOrder } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
        },
      });
      await this.audit.recordTx(tx, {
        entityType: 'product_template_attribute_value',
        entityId: existing.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { displayOrder: existing.displayOrder, active: existing.active },
        newValues: { displayOrder: updated.displayOrder, active: updated.active },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return updated;
    });
  }

  /** DELETE one selected value (falls back to the global universe if it was the last). */
  async removeTemplateAttributeValue(
    companyId: string,
    templateId: string,
    attributeId: string,
    valueId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const templateAttribute = await this.assertTemplateAttribute(
      companyId,
      templateId,
      attributeId,
    );
    const existing = await this.prisma.productTemplateAttributeValue.findUnique({
      where: {
        templateAttributeId_attributeValueId: {
          templateAttributeId: templateAttribute.id,
          attributeValueId: valueId,
        },
      },
    });
    if (!existing) {
      throw new NotFoundError('Template attribute value not found', { attributeId, valueId });
    }
    return this.prisma.$transaction(async (tx) => {
      await tx.productTemplateAttributeValue.delete({ where: { id: existing.id } });
      await this.audit.recordTx(tx, {
        entityType: 'product_template_attribute_value',
        entityId: existing.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { templateId, attributeId, attributeValueId: valueId },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { templateId, attributeId, valueId, removed: true };
    });
  }

  // ───────────────────── variant preview / generation ─────────────────────

  /**
   * Variant-defining attributes (createsVariants) with the global active
   * values AND the template's selected values (3B correction #2).
   */
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
        selectedValues: {
          where: { active: true },
          orderBy: [{ displayOrder: 'asc' }, { attributeValueId: 'asc' }],
          select: {
            id: true,
            displayOrder: true,
            attributeValue: { select: { id: true, code: true, valueFa: true } },
          },
        },
      },
    });
  }

  /**
   * 3B correction #2 — the effective value universe per template attribute:
   * the SELECTED (active) values whenever at least one selection exists;
   * otherwise — transitional rule for attributes that have not been curated
   * yet — the attribute's global active values. Documented in README.
   */
  private static effectiveUniverse(
    space: Array<{
      attributeId: string;
      attribute: { values: ValueMeta[] };
      selectedValues?: Array<{ attributeValue: ValueMeta | null }>;
    }>,
  ): Map<string, ValueMeta[]> {
    const universe = new Map<string, ValueMeta[]>();
    for (const s of space) {
      const selected = (s.selectedValues ?? [])
        .map((sv) => sv.attributeValue)
        .filter((v): v is ValueMeta => !!v);
      universe.set(s.attributeId, selected.length > 0 ? selected : s.attribute.values);
    }
    return universe;
  }

  /**
   * p3b-07 — preview: full cartesian product with SKU suggestions and
   * existsAlready markers. Restricted to the template's createsVariants
   * attributes and their value universe (selected values when present, else
   * the attribute's global active values). Deterministic for stable input.
   */
  async previewVariants(
    companyId: string,
    templateId: string,
    dto: PreviewVariantsDto,
  ) {
    const template = await this.assertTemplate(companyId, templateId);
    const space = await this.variantSpace(templateId);
    const variantAttributes = new Map(space.map((s) => [s.attributeId, s]));
    const universe = TemplatesService.effectiveUniverse(space);

    for (const selection of dto.selections) {
      if (!variantAttributes.has(selection.attributeId)) {
        throw new ValidationError('Attribute does not create variants on this template', {
          attributeId: selection.attributeId,
        });
      }
      // 3B correction #2 — combos are built ONLY from the value universe.
      const allowed = new Set(
        (universe.get(selection.attributeId) ?? []).map((v) => v.id),
      );
      for (const valueId of selection.valueIds) {
        if (!allowed.has(valueId)) {
          throw new ValidationError(VALUE_NOT_AVAILABLE_FOR_TEMPLATE, {
            attributeId: selection.attributeId,
            valueId,
          });
        }
      }
    }

    // Existing variants → combination keys, for existsAlready.
    const existingVariants = await this.prisma.productVariant.findMany({
      where: { templateId },
      select: { sku: true, values: { select: { attributeId: true, attributeValueId: true } } },
    });
    const existingKeys = new Set(
      existingVariants.map((v) =>
        buildCombinationKey(
          v.values.map((x) => ({ attributeId: x.attributeId, attributeValueId: x.attributeValueId })),
        ),
      ),
    );
    const existingSkus = new Set(existingVariants.map((v) => v.sku));

    const skuBase = template.internalCode ?? template.nameFa;
    const combos = cartesianProduct(dto.selections);

    // value lookup for codes; a value id belongs to exactly one attribute
    const valueMeta = new Map<string, { code: string; attributeId: string }>();
    for (const [attributeId, values] of universe) {
      for (const v of values) {
        valueMeta.set(v.id, { code: v.code, attributeId });
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
            existingKeys.has(
              buildCombinationKey(
                combo.map((p) => ({ attributeId: p.attributeId, attributeValueId: p.valueId })),
              ),
            ) || existingSkus.has(skuSuggestion),
        };
      }),
    };
  }

  /**
   * p3b-08/09 — generate the user-selected subset in ONE transaction.
   * Skip-with-report: an existing identical combination (same
   * attributeId=attributeValueId set under the template) is skipped, never
   * duplicated. The DB unique (template_id, combination_key) is the
   * authority: a concurrent duplicate that races past the pre-check surfaces
   * as P2002 → ConflictError VARIANT_COMBINATION_EXISTS (3B correction #4).
   * SKU collisions are auto-suffixed -2, -3; still colliding → ConflictError.
   * Existing variants are never mutated or deleted. Every variant row
   * persists its canonical combination_key.
   */
  async generateVariants(
    companyId: string,
    templateId: string,
    dto: GenerateVariantsDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<{
    created: Array<{ id: string; sku: string }>;
    skipped: Array<{ combination: SelectionPair[]; reason: string }>;
  }> {
    const template = await this.assertTemplate(companyId, templateId);
    const space = await this.variantSpace(templateId);
    const variantAttributes = new Map(space.map((s) => [s.attributeId, s]));
    const universe = TemplatesService.effectiveUniverse(space);
    const valueOwner = new Map<string, { attributeId: string; valueFa: string; code: string }>();
    for (const [attributeId, values] of universe) {
      for (const v of values) {
        valueOwner.set(v.id, { attributeId, valueFa: v.valueFa, code: v.code });
      }
    }

    // 3B correction #3 — weight validation fails the request fast (before any
    // write): weightPerUnit without weightUomId is invalid; the UOM must be a
    // same-company Weight-category unit.
    for (const combination of dto.combinations) {
      if (
        combination.weightPerUnit !== undefined &&
        combination.weightPerUnit !== null &&
        !combination.weightUomId
      ) {
        throw new ValidationError('WEIGHT_UOM_REQUIRED', {
          weightPerUnit: combination.weightPerUnit,
        });
      }
      if (combination.weightUomId) {
        await this.assertWeightUomValid(companyId, combination.weightUomId);
      }
    }

    const skuBase = template.internalCode ?? template.nameFa;
    // The batch's canonical keys (pure) — used to disambiguate a lost
    // concurrent race in wrapGenerationConflict.
    const batchKeys = dto.combinations.map((c) =>
      buildCombinationKey(
        c.selections.map((p) => ({
          attributeId: p.attributeId,
          attributeValueId: p.valueId,
        })),
      ),
    );

    try {
      return await this.prisma.$transaction(async (tx) => {
        // Existing variants inside the tx → skip duplicates (fast path; the
        // DB unique is the backstop for concurrent generation).
        const existingVariants = await tx.productVariant.findMany({
          where: { templateId },
          select: {
            sku: true,
            weightPerUnit: true,
            values: { select: { attributeId: true, attributeValueId: true } },
          },
        });
        const existingKeys = new Set(
          existingVariants.map((v) =>
            buildCombinationKey(
              v.values.map((x) => ({
                attributeId: x.attributeId,
                attributeValueId: x.attributeValueId,
              })),
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
          // Validate: each value belongs to the template's value universe for
          // a variant-defining attribute, and every attribute appears at most once.
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

          const key = buildCombinationKey(
            pairs.map((p) => ({ attributeId: p.attributeId, attributeValueId: p.valueId })),
          );
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
              // 3B correction #4 — canonical key persisted; the DB unique
              // (template_id, combination_key) makes duplicates impossible.
              combinationKey: key,
              // 3B correction #3 — optional explicit weight + unit.
              weightPerUnit:
                combination.weightPerUnit !== undefined &&
                combination.weightPerUnit !== null
                  ? new Prisma.Decimal(combination.weightPerUnit)
                  : undefined,
              weightUomId: combination.weightUomId ?? undefined,
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
            newValues: {
              templateId,
              sku,
              combinationKey: key,
              combination: pairs,
            },
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
    } catch (error) {
      // wrapGenerationConflict always throws (its `Promise<never>` result is
      // unreachable) — returning the never-expression keeps the return type
      // exact for TypeScript without a dummy throw.
      return await this.wrapGenerationConflict(error, templateId, batchKeys);
    }
  }

  /**
   * PATCH variant — weight (weightPerUnit/weightUomId), default UOM, name and
   * active flag with optimistic locking. Weight rules per 3B correction #3.
   */
  async updateVariant(
    companyId: string,
    templateId: string,
    variantId: string,
    dto: UpdateVariantDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const template = await this.assertTemplate(companyId, templateId);
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: {
        id: true,
        companyId: true,
        templateId: true,
        sku: true,
        nameFa: true,
        weightPerUnit: true,
        weightUomId: true,
        active: true,
        version: true,
      },
    });
    if (!variant || variant.companyId !== companyId || variant.templateId !== templateId) {
      throw new NotFoundError('Variant not found', { templateId, variantId });
    }
    if (dto.defaultUomId) await this.assertSameCompanyRef('uom', companyId, dto.defaultUomId);

    // Weight validation on the MERGED result (3B correction #3). Only
    // enforced when the request touches weight fields, so unrelated PATCHes
    // of legacy rows keep working.
    if (dto.weightPerUnit !== undefined || dto.weightUomId !== undefined) {
      const weightStaysSet =
        dto.weightPerUnit !== undefined
          ? dto.weightPerUnit !== null
          : variant.weightPerUnit !== null;
      const mergedWeightUomId =
        dto.weightUomId !== undefined ? dto.weightUomId : variant.weightUomId;
      if (weightStaysSet && !mergedWeightUomId) {
        throw new ValidationError('WEIGHT_UOM_REQUIRED', { weightPerUnit: dto.weightPerUnit });
      }
      if (mergedWeightUomId) {
        await this.assertWeightUomValid(companyId, mergedWeightUomId);
      }
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.productVariant.update({
          // Optimistic lock: version must match or Prisma raises P2025.
          where: { id: variantId, version: dto.version },
          data: {
            ...(dto.nameFa !== undefined ? { nameFa: dto.nameFa } : {}),
            ...(dto.defaultUomId !== undefined ? { defaultUomId: dto.defaultUomId } : {}),
            ...(dto.weightPerUnit !== undefined
              ? {
                  weightPerUnit:
                    dto.weightPerUnit === null
                      ? null
                      : new Prisma.Decimal(dto.weightPerUnit),
                }
              : {}),
            ...(dto.weightUomId !== undefined ? { weightUomId: dto.weightUomId } : {}),
            ...(dto.active !== undefined ? { active: dto.active } : {}),
            version: { increment: 1 },
          },
        });
        await this.audit.recordTx(tx, {
          entityType: 'product_variant',
          entityId: variantId,
          action: AuditAction.UPDATE,
          companyId,
          actor,
          oldValues: {
            sku: variant.sku,
            nameFa: variant.nameFa,
            weightPerUnit: variant.weightPerUnit,
            weightUomId: variant.weightUomId,
            active: variant.active,
            version: variant.version,
          },
          newValues: {
            sku: updated.sku,
            nameFa: updated.nameFa,
            weightPerUnit: updated.weightPerUnit,
            weightUomId: updated.weightUomId,
            active: updated.active,
            version: updated.version,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
    } catch (error) {
      TemplatesService.wrapVersionConflict(error);
    }
  }

  /**
   * Phase-4 matrix: columns = first createsVariants attribute, rows = the
   * remaining ones, cells = existing variants keyed by their combination.
   * Column/row values come from the template's value universe (3B
   * correction #2).
   */
  async matrix(companyId: string, templateId: string) {
    await this.assertTemplate(companyId, templateId);
    const space = await this.variantSpace(templateId);
    const universe = TemplatesService.effectiveUniverse(space);
    const toValues = (attributeId: string) =>
      (universe.get(attributeId) ?? []).map((v) => ({
        id: v.id,
        code: v.code,
        valueFa: v.valueFa,
      }));
    const columns = space.slice(0, 1).map((s) => ({
      attributeId: s.attributeId,
      nameFa: s.attribute.nameFa,
      values: toValues(s.attributeId),
    }));
    const rows = space.slice(1).map((s) => ({
      attributeId: s.attributeId,
      nameFa: s.attribute.nameFa,
      values: toValues(s.attributeId),
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
