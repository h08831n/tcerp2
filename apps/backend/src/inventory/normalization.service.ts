import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { applyConversion } from '../products/uom-conversion.service';
import { D, roundQuantity } from '../common/utils/money';

type Client = Prisma.TransactionClient | PrismaService;

export const NORMALIZATION_MESSAGES = {
  inventoryUomMissing: 'INVENTORY_UOM_MISSING',
  conversionImpossible: 'UOM_CONVERSION_IMPOSSIBLE',
  uomLocked: 'INVENTORY_UOM_LOCKED',
  negativeBlocked: 'NEGATIVE_STOCK_BLOCKED',
  uomNotInCompany: 'UOM_NOT_IN_COMPANY',
} as const;

/** Setting key: ALLOW | WARN | BLOCK (default WARN) — see assertNegativePolicy. */
export const NEGATIVE_STOCK_POLICY_SETTING = 'inventory.negative_stock_policy';
export type NegativeStockPolicy = 'ALLOW' | 'WARN' | 'BLOCK';

const UOM_COLUMNS = {
  id: true,
  companyId: true,
  categoryId: true,
  symbol: true,
  conversionRatio: true,
} as const;

/**
 * Integrity Gate #1/#2 — UOM normalization for inventory (Phase 6).
 *
 * Every StockMovement stores BOTH:
 *   - sourceQuantity/sourceUomId — the ORIGINAL operational quantity, kept
 *     verbatim for audit; and
 *   - normalizedQuantity/inventoryUomId — the quantity expressed in the
 *     variant's inventory UOM. normalizedQuantity is the ONLY column stock
 *     aggregation may ever SUM (#1, #2).
 *
 * Normalization rules:
 *   - same category → the pure UOM-engine ratio (applyConversion);
 *   - CROSS-category ONLY through the variant's product-weight pair
 *     (weightPerUnit × weightUomId): pieces × weightPerUnit → weight UOM →
 *     target. Without a complete pair — or when the weight UOM's category
 *     does not match the target — the conversion is
 *     UOM_CONVERSION_IMPOSSIBLE (never guessed).
 *
 * insertStockMovement() is the single write seam: it computes the
 * normalized values internally and inserts with ON CONFLICT DO NOTHING so
 * the unique idempotency_key stays the only duplicate authority (a mid-
 * transaction P2002 would poison the transaction — Postgres 25P02).
 */
@Injectable()
export class NormalizationService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────── inventory UOM resolution ─────────────────────────

  /**
   * The variant's authoritative inventory UOM: `inventoryUomId` falling back
   * to `defaultUomId`. A variant with NEITHER is a 422 INVENTORY_UOM_MISSING
   * — stock can never be aggregated without a reference unit.
   */
  async resolveInventoryUom(companyId: string, variantId: string): Promise<string> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, companyId },
      select: { inventoryUomId: true, defaultUomId: true },
    });
    if (!variant) throw new NotFoundError('Product variant not found', { variantId });
    return this.resolveVariantInventoryUom(variant, variantId);
  }

  /** Variant-row overload (avoids a re-read inside transactions). */
  resolveVariantInventoryUom(
    variant: { inventoryUomId?: string | null; defaultUomId?: string | null },
    variantId: string,
  ): string {
    const uomId = variant.inventoryUomId ?? variant.defaultUomId;
    if (!uomId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.inventoryUomMissing, { variantId });
    }
    return uomId;
  }

  // ───────────────────────── quantity normalization ─────────────────────────

  /**
   * Normalize `quantity` (expressed in `sourceUomId`) into the variant's
   * inventory UOM. Exact Prisma.Decimal math, rounded to the quantity column
   * scale once at the end.
   */
  async normalizeQuantity(
    companyId: string,
    variantId: string,
    quantity: Prisma.Decimal | number | string,
    sourceUomId: string,
  ): Promise<Prisma.Decimal> {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, companyId },
      select: {
        id: true,
        inventoryUomId: true,
        defaultUomId: true,
        weightPerUnit: true,
        weightUomId: true,
      },
    });
    if (!variant) throw new NotFoundError('Product variant not found', { variantId });
    const inventoryUomId = this.resolveVariantInventoryUom(variant, variantId);

    const [source, target] = await Promise.all([
      this.prisma.uom.findUnique({ where: { id: sourceUomId }, select: UOM_COLUMNS }),
      this.prisma.uom.findUnique({ where: { id: inventoryUomId }, select: UOM_COLUMNS }),
    ]);
    if (!source || !target) {
      throw new ValidationError('UOM not found', { sourceUomId, inventoryUomId });
    }
    if (source.companyId !== companyId || target.companyId !== companyId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.uomNotInCompany, {
        sourceUomId,
        inventoryUomId,
      });
    }

    const decimal = D(quantity);
    if (source.id === target.id) return roundQuantity(decimal);

    // Same category → the pure ratio rule.
    if (source.categoryId === target.categoryId) {
      return roundQuantity(applyConversion(source, target, decimal).value);
    }

    // Cross-category → ONLY via the product-weight pair (pieces ×
    // weightPerUnit → weight UOM → target). The weight UOM's category must
    // be the TARGET's category — the result is a weight, so it can never
    // land in a count category. No complete pair / mismatched categories →
    // impossible (never guessed).
    const weightPerUnit = variant.weightPerUnit;
    const weightUomId = variant.weightUomId;
    if (weightPerUnit === null || weightPerUnit === undefined || !weightUomId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.conversionImpossible, {
        sourceUomId: source.id,
        inventoryUomId: target.id,
        reason: 'NO_WEIGHT_PAIR',
      });
    }
    const weightUom = await this.prisma.uom.findUnique({ where: { id: weightUomId }, select: UOM_COLUMNS });
    if (!weightUom) throw new ValidationError('UOM not found', { weightUomId });
    if (weightUom.companyId !== companyId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.uomNotInCompany, { weightUomId });
    }
    if (weightUom.categoryId !== target.categoryId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.conversionImpossible, {
        sourceUomId: source.id,
        inventoryUomId: target.id,
        reason: 'WEIGHT_CATEGORY_MISMATCH',
      });
    }
    // quantity (count units) × weightPerUnit → weight in the weight UOM …
    const totalWeight = decimal.mul(D(weightPerUnit));
    // … then the standard same-category conversion to the inventory UOM.
    return roundQuantity(applyConversion(weightUom, target, totalWeight).value);
  }

  /**
   * Convert between two arbitrary UOMs for one variant using the same rules
   * as normalizeQuantity (same-category ratio, else the product-weight path
   * into the weight category and back out). Used by the loading allocation
   * guard and goods receipts to express a quantity in a DOCUMENT line's UOM.
   * Impossible → UOM_CONVERSION_IMPOSSIBLE.
   */
  async convertBetween(
    companyId: string,
    variantId: string,
    quantity: Prisma.Decimal | number | string,
    fromUomId: string,
    toUomId: string,
  ): Promise<Prisma.Decimal> {
    const decimal = D(quantity);
    if (fromUomId === toUomId) return roundQuantity(decimal);

    const [from, to, variant] = await Promise.all([
      this.prisma.uom.findUnique({ where: { id: fromUomId }, select: UOM_COLUMNS }),
      this.prisma.uom.findUnique({ where: { id: toUomId }, select: UOM_COLUMNS }),
      this.prisma.productVariant.findFirst({
        where: { id: variantId, companyId },
        select: { weightPerUnit: true, weightUomId: true },
      }),
    ]);
    if (!from || !to) throw new ValidationError('UOM not found', { fromUomId, toUomId });
    if (from.companyId !== companyId || to.companyId !== companyId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.uomNotInCompany, { fromUomId, toUomId });
    }
    if (from.categoryId === to.categoryId) {
      return roundQuantity(applyConversion(from, to, decimal).value);
    }

    const weightPerUnit = variant?.weightPerUnit;
    const weightUomId = variant?.weightUomId ?? null;
    if (weightPerUnit === null || weightPerUnit === undefined || !weightUomId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.conversionImpossible, {
        fromUomId: from.id,
        toUomId: to.id,
        reason: 'NO_WEIGHT_PAIR',
      });
    }
    const weightUom = await this.prisma.uom.findUnique({ where: { id: weightUomId }, select: UOM_COLUMNS });
    if (!weightUom) throw new ValidationError('UOM not found', { weightUomId });
    if (weightUom.companyId !== companyId) {
      throw new ValidationError(NORMALIZATION_MESSAGES.uomNotInCompany, { weightUomId });
    }

    // pieces → weight: quantity × weightPerUnit (in the weight UOM) → to.
    if (from.categoryId !== weightUom.categoryId && to.categoryId === weightUom.categoryId) {
      const totalWeight = decimal.mul(D(weightPerUnit));
      return roundQuantity(applyConversion(weightUom, to, totalWeight).value);
    }
    // weight → pieces: from → weight UOM, ÷ weightPerUnit (per ONE unit of
    // the target count UOM — the symmetric inverse of the branch above).
    if (from.categoryId === weightUom.categoryId && to.categoryId !== weightUom.categoryId) {
      const weight = applyConversion(from, weightUom, decimal).value;
      return roundQuantity(weight.div(D(weightPerUnit)));
    }
    throw new ValidationError(NORMALIZATION_MESSAGES.conversionImpossible, {
      fromUomId: from.id,
      toUomId: to.id,
      reason: 'NO_WEIGHT_BRIDGE',
    });
  }

  // ───────────────────────── movement write seam ─────────────────────────

  /**
   * The ONLY way operational code writes StockMovements: normalizes the
   * source quantity into the variant's inventory UOM and inserts the row
   * with ON CONFLICT DO NOTHING (see class doc — the unique idempotency_key
   * is the only duplicate authority). Returns true when a row was inserted.
   */
  async insertStockMovement(
    tx: Client,
    data: {
      companyId: string;
      productVariantId: string;
      quantity: Prisma.Decimal | number | string;
      uomId: string;
      direction: 'IN' | 'OUT';
      sourceLocationId: string;
      destinationLocationId: string;
      warehouseId?: string | null;
      movementDate: Date;
      sourceEntityType: string;
      sourceEntityId: string;
      idempotencyKey: string;
      reversalOfMovementId?: string | null;
      createdBy?: string | null;
    },
  ): Promise<boolean> {
    const normalizedQuantity = await this.normalizeQuantity(
      data.companyId,
      data.productVariantId,
      data.quantity,
      data.uomId,
    );
    const inventoryUomId = await this.resolveInventoryUom(data.companyId, data.productVariantId);
    // BLOCK policy gate (#7) — enforced at the single write seam so EVERY
    // movement producer (loadings, goods receipts, transfers and their
    // reversals) is covered: a movement whose SOURCE is an INTERNAL location
    // drains that location by the normalized quantity, and when the company
    // policy is BLOCK that drain may not push it below zero.
    await this.assertNegativePolicy(
      tx,
      data.companyId,
      data.sourceLocationId,
      data.productVariantId,
      D(normalizedQuantity).neg(),
    );
    return NormalizationService.insertNormalizedMovement(tx, {
      companyId: data.companyId,
      productVariantId: data.productVariantId,
      sourceQuantity: roundQuantity(D(data.quantity)),
      sourceUomId: data.uomId,
      normalizedQuantity,
      inventoryUomId,
      direction: data.direction,
      sourceLocationId: data.sourceLocationId,
      destinationLocationId: data.destinationLocationId,
      warehouseId: data.warehouseId ?? null,
      movementDate: data.movementDate,
      sourceEntityType: data.sourceEntityType,
      sourceEntityId: data.sourceEntityId,
      idempotencyKey: data.idempotencyKey,
      reversalOfMovementId: data.reversalOfMovementId ?? null,
      createdBy: data.createdBy ?? null,
    });
  }

  /**
   * Raw idempotent insert of an ALREADY-normalized movement (reversals reuse
   * the original row's normalized values verbatim). ON CONFLICT DO NOTHING.
   */
  static async insertNormalizedMovement(
    tx: Client,
    data: {
      companyId: string;
      productVariantId: string;
      sourceQuantity: Prisma.Decimal;
      sourceUomId: string;
      normalizedQuantity: Prisma.Decimal;
      inventoryUomId: string;
      direction: 'IN' | 'OUT';
      sourceLocationId: string;
      destinationLocationId: string;
      warehouseId: string | null;
      movementDate: Date;
      sourceEntityType: string;
      sourceEntityId: string;
      idempotencyKey: string;
      reversalOfMovementId: string | null;
      createdBy: string | null;
    },
  ): Promise<boolean> {
    const inserted = await tx.$executeRaw`
      INSERT INTO stock_movements
        (id, company_id, product_variant_id, source_quantity, source_uom_id,
         normalized_quantity, inventory_uom_id, direction, source_location_id,
         destination_location_id, warehouse_id, movement_date, source_entity_type,
         source_entity_id, idempotency_key, reversal_of_movement_id, created_by)
      VALUES
        (${randomUUID()}::uuid, ${data.companyId}::uuid, ${data.productVariantId}::uuid,
         ${data.sourceQuantity}, ${data.sourceUomId}::uuid, ${data.normalizedQuantity},
         ${data.inventoryUomId}::uuid, ${data.direction}::"StockDirection",
         ${data.sourceLocationId}::uuid, ${data.destinationLocationId}::uuid,
         ${data.warehouseId}::uuid, ${data.movementDate}, ${data.sourceEntityType},
         ${data.sourceEntityId}::uuid, ${data.idempotencyKey}, ${data.reversalOfMovementId}::uuid,
         ${data.createdBy}::uuid)
      ON CONFLICT (idempotency_key) DO NOTHING
    `;
    return inserted === 1;
  }

  // ───────────────────────── negative-stock policy ─────────────────────────

  /** Read `inventory.negative_stock_policy` (ALLOW | WARN | BLOCK); default WARN. */
  async negativeStockPolicy(companyId: string, tx?: Client): Promise<NegativeStockPolicy> {
    const db = tx ?? this.prisma;
    const setting = await db.setting.findUnique({
      where: { companyId_key: { companyId, key: NEGATIVE_STOCK_POLICY_SETTING } },
      select: { value: true },
    });
    const raw = setting?.value as unknown;
    const policy =
      typeof raw === 'string'
        ? raw
        : raw && typeof raw === 'object' && 'policy' in (raw as object)
          ? String((raw as { policy?: unknown }).policy)
          : raw && typeof raw === 'object' && 'value' in (raw as object)
            ? String((raw as { value?: unknown }).value)
            : 'WARN';
    return policy === 'ALLOW' || policy === 'BLOCK' ? policy : 'WARN';
  }

  /**
   * Current normalized stock of one variant AT one location (the location
   * semantics of the stock query, scoped to a single location): +q when the
   * movement ends here (from elsewhere), −q when it starts here.
   */
  static async stockAtLocation(
    tx: Client,
    locationId: string,
    variantId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.$queryRaw<{ stock: Prisma.Decimal }[]>`
      SELECT COALESCE(SUM(
        CASE
          WHEN sm.destination_location_id = ${locationId}::uuid AND sm.source_location_id <> sm.destination_location_id THEN sm.normalized_quantity
          WHEN sm.source_location_id = ${locationId}::uuid AND sm.source_location_id <> sm.destination_location_id THEN -sm.normalized_quantity
          ELSE 0
        END
      ), 0) AS stock
      FROM stock_movements sm
      WHERE sm.product_variant_id = ${variantId}::uuid
        AND (sm.source_location_id = ${locationId}::uuid OR sm.destination_location_id = ${locationId}::uuid)
    `;
    return D(rows[0]?.stock ?? 0);
  }

  /**
   * BLOCK policy gate (#7): when the company policy is BLOCK, a write that
   * would push an INTERNAL location's stock for the variant below zero is
   * rejected (NEGATIVE_STOCK_BLOCKED). WARN (default) / ALLOW only flag it
   * on the stock query — nothing is blocked.
   */
  async assertNegativePolicy(
    tx: Client,
    companyId: string,
    locationId: string,
    variantId: string,
    delta: Prisma.Decimal | number | string,
  ): Promise<void> {
    const policy = await this.negativeStockPolicy(companyId, tx);
    if (policy !== 'BLOCK') return;
    if (!D(delta).lt(0)) return;
    const location = await tx.stockLocation.findFirst({
      where: { id: locationId, companyId },
      select: { id: true, type: true },
    });
    if (!location || location.type !== 'INTERNAL') return;
    const current = await NormalizationService.stockAtLocation(tx, locationId, variantId);
    if (current.plus(D(delta)).lt(0)) {
      throw new ValidationError(NORMALIZATION_MESSAGES.negativeBlocked, {
        locationId,
        variantId,
        current: current.toString(),
        requested: D(delta).toString(),
      });
    }
  }

  // ───────────────────────── variant inventory-UOM guard (#2) ─────────────────────────

  /**
   * Integrity Gate #2 — the inventory UOM is controlled once movements
   * exist: a PATCH that would CHANGE it on a variant with any stock_movement
   * is a 403 INVENTORY_UOM_LOCKED (aggregated history is expressed in that
   * unit and can never be silently re-based). The UOM must belong to the
   * same company (UOM_NOT_IN_COMPANY otherwise). `null` clears the override
   * (falling back to defaultUomId) — still a change, still locked.
   */
  async assertInventoryUomEditable(
    companyId: string,
    variantId: string,
    inventoryUomId: string | null | undefined,
    currentInventoryUomId?: string | null,
  ): Promise<void> {
    if (inventoryUomId === undefined) return;
    if (inventoryUomId && inventoryUomId !== currentInventoryUomId) {
      const uom = await this.prisma.uom.findFirst({
        where: { id: inventoryUomId, companyId },
        select: { id: true },
      });
      if (!uom) {
        throw new ValidationError(NORMALIZATION_MESSAGES.uomNotInCompany, { inventoryUomId });
      }
    }
    if (inventoryUomId === (currentInventoryUomId ?? null)) return;
    const movements = await this.prisma.stockMovement.count({
      where: { companyId, productVariantId: variantId },
    });
    if (movements > 0) {
      throw new ForbiddenError(NORMALIZATION_MESSAGES.uomLocked, {
        variantId,
        movementCount: movements,
      });
    }
  }
}
