import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValidationError } from '../common/errors';

export interface UomLike {
  id: string;
  categoryId: string;
  symbol: string;
  conversionRatio: Prisma.Decimal | string | number;
}

export interface ConversionResult {
  value: Prisma.Decimal;
  fromSymbol: string;
  toSymbol: string;
  categoryId: string;
}

const UOM_SELECT = {
  id: true,
  companyId: true,
  categoryId: true,
  symbol: true,
  conversionRatio: true,
} as const;

/**
 * Pure ratio application: value × from.ratio ÷ to.ratio (Decimal).
 * Both UOMs must belong to the same category → UOM_CATEGORY_MISMATCH.
 */
export function applyConversion(
  from: UomLike,
  to: UomLike,
  value: Prisma.Decimal | string | number,
): ConversionResult {
  if (from.categoryId !== to.categoryId) {
    throw new ValidationError('UOM_CATEGORY_MISMATCH', {
      fromUomId: from.id,
      toUomId: to.id,
      fromCategoryId: from.categoryId,
      toCategoryId: to.categoryId,
    });
  }
  const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
  const result = decimal
    .mul(new Prisma.Decimal(from.conversionRatio))
    .div(new Prisma.Decimal(to.conversionRatio));
  return {
    value: result,
    fromSymbol: from.symbol,
    toSymbol: to.symbol,
    categoryId: from.categoryId,
  };
}

/**
 * p3b-10/11/12 — UOM conversion engine. All arithmetic is Prisma.Decimal —
 * never float. Conversions are allowed only INSIDE one UOM category, and a
 * category must have an ACTIVE base unit before anything in it converts
 * (UOM_NO_BASE_UNIT, 3B correction #4 — "at most one" base per category is
 * enforced in uoms.service; a category can transiently have none, which
 * blocks conversion until a base exists). The cross-category path is allowed
 * only through the explicit product-weight conversion
 * (`convertWithProductWeight`) when the variant carries BOTH weightPerUnit
 * and its weightUomId.
 */
@Injectable()
export class UomConversionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 3B correction #4 — nothing in a category converts until an active base exists. */
  private async assertActiveBase(categoryId: string): Promise<void> {
    const base = await this.prisma.uom.findFirst({
      where: { categoryId, isBaseUnit: true, active: true },
      select: { id: true, symbol: true },
    });
    if (!base) {
      throw new ValidationError('UOM_NO_BASE_UNIT', { categoryId });
    }
  }

  private static assertSameCompany(
    companyId: string | undefined,
    uom: { id: string; companyId: string },
    slot: 'fromUomId' | 'toUomId' | 'weightUomId',
  ): void {
    if (companyId && uom.companyId !== companyId) {
      throw new ValidationError('UOM_NOT_IN_COMPANY', { [slot]: uom.id });
    }
  }

  /** DB-backed conversion: loads both UOMs and applies the pure ratio rule. */
  async convert(
    value: Prisma.Decimal | string | number,
    fromUomId: string,
    toUomId: string,
    companyId?: string,
  ): Promise<ConversionResult> {
    const [from, to] = await Promise.all([
      this.prisma.uom.findUnique({ where: { id: fromUomId }, select: UOM_SELECT }),
      this.prisma.uom.findUnique({ where: { id: toUomId }, select: UOM_SELECT }),
    ]);
    if (!from || !to) {
      throw new ValidationError('UOM not found', { fromUomId, toUomId });
    }
    UomConversionService.assertSameCompany(companyId, from, 'fromUomId');
    UomConversionService.assertSameCompany(companyId, to, 'toUomId');
    await this.assertActiveBase(from.categoryId);
    await this.assertActiveBase(to.categoryId);
    return applyConversion(from, to, value);
  }

  /**
   * p3b-12 — product-specific weight path (3B correction #3). Requires the
   * variant to carry BOTH weightPerUnit AND its weightUomId:
   *
   *   result = (quantity × weightPerUnit [in the weight UOM])
   *            → standard same-category conversion weight UOM → target
   *            (e.g. 100 pieces × 18.7 kg/piece = 1870 kg → 1.87 ton).
   *
   * WITHOUT a complete weight pair the normal strict same-category rule
   * applies (cross-category → UOM_CATEGORY_MISMATCH). The weight UOM's
   * category must be the company's Weight category; the target must sit in
   * that same category or applyConversion blocks it.
   */
  async convertWithProductWeight(
    value: Prisma.Decimal | string | number,
    fromUomId: string,
    toUomId: string,
    variant: {
      weightPerUnit: Prisma.Decimal | string | number | null;
      weightUomId?: string | null;
    } | null,
    companyId?: string,
  ): Promise<ConversionResult> {
    const [from, to] = await Promise.all([
      this.prisma.uom.findUnique({ where: { id: fromUomId }, select: UOM_SELECT }),
      this.prisma.uom.findUnique({ where: { id: toUomId }, select: UOM_SELECT }),
    ]);
    if (!from || !to) {
      throw new ValidationError('UOM not found', { fromUomId, toUomId });
    }
    UomConversionService.assertSameCompany(companyId, from, 'fromUomId');
    UomConversionService.assertSameCompany(companyId, to, 'toUomId');

    const weight = variant?.weightPerUnit;
    const weightUomId = variant?.weightUomId ?? null;
    if (weight === null || weight === undefined || !weightUomId) {
      // No complete product-weight pair → strict same-category rule.
      await this.assertActiveBase(from.categoryId);
      await this.assertActiveBase(to.categoryId);
      return applyConversion(from, to, value);
    }

    const weightUom = await this.prisma.uom.findUnique({
      where: { id: weightUomId },
      select: UOM_SELECT,
    });
    if (!weightUom) {
      throw new ValidationError('UOM not found', { weightUomId });
    }
    UomConversionService.assertSameCompany(companyId, weightUom, 'weightUomId');

    // quantity × weightPerUnit → weight expressed in the weight UOM …
    const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    const totalWeight = decimal.mul(new Prisma.Decimal(weight));
    // … then the standard Weight-category conversion to the target
    // (kg → ton); a non-weight target is blocked by the category guard.
    const result = applyConversion(weightUom, to, totalWeight);
    await this.assertActiveBase(weightUom.categoryId);
    return {
      value: result.value,
      fromSymbol: from.symbol,
      toSymbol: to.symbol,
      categoryId: weightUom.categoryId,
    };
  }
}
