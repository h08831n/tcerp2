import { Prisma } from '@prisma/client';

/**
 * Central money/quantity arithmetic (Phase 4).
 *
 * All calculations use Prisma.Decimal (decimal.js) — exact base-10 math, never
 * floating point. Server-authoritative: line and document totals are ALWAYS
 * recomputed here; client-sent totals are ignored. Money columns are
 * Decimal(20,4), quantities Decimal(18,4) — every result is rounded once, at
 * the end, with ROUND_HALF_UP at the column scale.
 */

export type DecimalInput = string | number | Prisma.Decimal | null | undefined;

/** Scale of money columns (Decimal(20,4)). */
export const MONEY_SCALE = 4;
/** Scale of quantity columns (Decimal(18,4)). */
export const QTY_SCALE = 4;

/** Coerce any accepted input to an exact Prisma.Decimal (null/undefined → 0). */
export function D(value: DecimalInput): Prisma.Decimal {
  if (value === null || value === undefined || value === '') return new Prisma.Decimal(0);
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value);
}

/** Round to the money column scale once, at the end of a computation. */
export function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/** Round to the quantity column scale. */
export function roundQuantity(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(QTY_SCALE, Prisma.Decimal.ROUND_HALF_UP);
}

/** Prisma column representation for a Decimal value. */
export function moneyString(value: DecimalInput): string {
  return roundMoney(D(value)).toFixed(MONEY_SCALE);
}

export interface LineTotalsInput {
  quantity: DecimalInput;
  unitPrice: DecimalInput;
  discountAmount?: DecimalInput;
  /** Tax rate PERCENT (e.g. 9 for 9%), snapshotted from the TaxDefinition. */
  taxRate?: DecimalInput;
}

export interface LineTotals {
  /** quantity × unitPrice */
  subtotal: Prisma.Decimal;
  /** (subtotal − discount) × taxRate / 100 */
  taxAmount: Prisma.Decimal;
  /** subtotal − discount + tax */
  lineTotal: Prisma.Decimal;
}

/**
 * One sales/price line: subtotal = quantity × unitPrice;
 * taxAmount = (subtotal − discount) × taxRate/100 (only when a tax rate is
 * given); lineTotal = subtotal − discount + tax.
 */
export function calcLineTotals(input: LineTotalsInput): LineTotals {
  const quantity = D(input.quantity);
  const unitPrice = D(input.unitPrice);
  const discount = D(input.discountAmount);

  const subtotal = roundMoney(quantity.times(unitPrice));

  let taxAmount = new Prisma.Decimal(0);
  if (input.taxRate !== null && input.taxRate !== undefined) {
    const taxable = subtotal.minus(discount);
    taxAmount = roundMoney(taxable.times(D(input.taxRate)).dividedBy(100));
  }

  const lineTotal = roundMoney(subtotal.minus(discount).plus(taxAmount));
  return { subtotal, taxAmount, lineTotal };
}

export interface DocumentTotals {
  subtotal: Prisma.Decimal;
  discountTotal: Prisma.Decimal;
  taxTotal: Prisma.Decimal;
  total: Prisma.Decimal;
}

/**
 * Sum pre-computed line totals into document totals (server-authoritative).
 * Field types are deliberately loose (unknown) so Prisma unchecked-create
 * row objects can be passed directly.
 */
export function sumDocumentTotals(
  lines: { subtotal: unknown; discountAmount?: unknown; taxAmount?: unknown; lineTotal: unknown }[],
): DocumentTotals {
  const subtotal = lines.reduce((acc, l) => acc.plus(D(l.subtotal as DecimalInput)), new Prisma.Decimal(0));
  const discountTotal = lines.reduce((acc, l) => acc.plus(D(l.discountAmount as DecimalInput)), new Prisma.Decimal(0));
  const taxTotal = lines.reduce((acc, l) => acc.plus(D(l.taxAmount as DecimalInput)), new Prisma.Decimal(0));
  const total = lines.reduce((acc, l) => acc.plus(D(l.lineTotal as DecimalInput)), new Prisma.Decimal(0));
  return {
    subtotal: roundMoney(subtotal),
    discountTotal: roundMoney(discountTotal),
    taxTotal: roundMoney(taxTotal),
    total: roundMoney(total),
  };
}

/** Simple purchase line: lineTotal = quantity × unitPrice (no discount/tax columns). */
export function calcPurchaseLineTotal(input: { quantity: DecimalInput; unitPrice: DecimalInput }): Prisma.Decimal {
  return roundMoney(D(input.quantity).times(D(input.unitPrice)));
}
