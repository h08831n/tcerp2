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
 * never float. Conversions are allowed only INSIDE one UOM category;
 * the cross-category path is allowed only through the explicit
 * product-weight conversion (`convertWithProductWeight`) when the variant
 * carries a weightPerUnit.
 */
@Injectable()
export class UomConversionService {
  constructor(private readonly prisma: PrismaService) {}

  /** DB-backed conversion: loads both UOMs and applies the pure ratio rule. */
  async convert(
    value: Prisma.Decimal | string | number,
    fromUomId: string,
    toUomId: string,
  ): Promise<ConversionResult> {
    const [from, to] = await Promise.all([
      this.prisma.uom.findUnique({ where: { id: fromUomId }, select: UOM_SELECT }),
      this.prisma.uom.findUnique({ where: { id: toUomId }, select: UOM_SELECT }),
    ]);
    if (!from || !to) {
      throw new ValidationError('UOM not found', { fromUomId, toUomId });
    }
    return applyConversion(from, to, value);
  }

  /**
   * p3b-12 — product-specific weight path. When the variant carries a
   * weightPerUnit (kg per unit), pieces → kg is allowed across categories:
   * result = value × weightPerUnit. WITHOUT a weightPerUnit the normal
   * same-category rule applies (cross-category → UOM_CATEGORY_MISMATCH).
   */
  async convertWithProductWeight(
    value: Prisma.Decimal | string | number,
    fromUomId: string,
    toUomId: string,
    variant: { weightPerUnit: Prisma.Decimal | string | number | null } | null,
  ): Promise<ConversionResult> {
    const [from, to] = await Promise.all([
      this.prisma.uom.findUnique({ where: { id: fromUomId }, select: UOM_SELECT }),
      this.prisma.uom.findUnique({ where: { id: toUomId }, select: UOM_SELECT }),
    ]);
    if (!from || !to) {
      throw new ValidationError('UOM not found', { fromUomId, toUomId });
    }
    const weight = variant?.weightPerUnit;
    if (weight === null || weight === undefined) {
      // No product weight known → fall back to the strict same-category rule.
      return applyConversion(from, to, value);
    }
    const decimal = value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
    return {
      value: decimal.mul(new Prisma.Decimal(weight)),
      fromSymbol: from.symbol,
      toSymbol: to.symbol,
      categoryId: to.categoryId,
    };
  }
}
