import { Inject, Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma, StockLocationType, Warehouse } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import { D } from '../common/utils/money';
import { NormalizationService } from './normalization.service';
import {
  CreateTransferDto,
  CreateWarehouseDto,
  MovementQueryDto,
  StockQueryDto,
  UpdateWarehouseDto,
} from './inventory.dto';

type Client = Prisma.TransactionClient | PrismaService;

export const INVENTORY_MESSAGES = {
  codeExists: 'WAREHOUSE_CODE_EXISTS',
  defaultExists: 'WAREHOUSE_DEFAULT_EXISTS',
  inUse: 'WAREHOUSE_IN_USE',
  warehouseRequired: 'WAREHOUSE_REQUIRED',
  transferSameWarehouse: 'TRANSFER_SAME_WAREHOUSE',
  quantityPositive: 'TRANSFER_QUANTITY_POSITIVE',
  invalidLocationType: 'INVALID_LOCATION_TYPE',
  uomRequired: 'UOM_REQUIRED',
  uomNotInCompany: 'UOM_NOT_IN_COMPANY',
  negativeBlocked: 'NEGATIVE_STOCK_BLOCKED',
} as const;

export const DEFAULT_WAREHOUSE_CODE = 'MAIN';
export const DEFAULT_WAREHOUSE_NAME_FA = 'انبار مرکزی';

/** Default external location codes per company (Integrity Gate #6). */
export const DEFAULT_SUPPLIER_LOCATION_CODE = 'SUPPLIER-DEFAULT';
export const DEFAULT_CUSTOMER_LOCATION_CODE = 'CUSTOMER-DEFAULT';

interface WarehouseRef {
  id: string;
  code: string;
  nameFa: string;
}

export interface ResolveLocationInput {
  type: 'SUPPLIER' | 'INTERNAL' | 'CUSTOMER';
  warehouseId?: string | null;
  partyId?: string | null;
}

/**
 * Inventory (Phase 6, REQUIREMENTS §21 + Integrity Gate #6/#7):
 *
 * - StockMovements are generated ONLY from operational documents — confirmed
 *   Loadings and confirmed GoodsReceipts (plus their reversals). No manual
 *   stock entry exists and none may be added (boundary §5); the internal
 *   warehouse→warehouse TRANSFER is the single deliberate exception (it
 *   moves stock between two INTERNAL locations — company total unchanged).
 * - A movement goes FROM a location TO a location (#6). Company physical
 *   stock = INTERNAL locations only (#7): +q when the movement ARRIVES at an
 *   INTERNAL location from a non-internal one, −q when it LEAVES an INTERNAL
 *   location for a non-internal one, 0 when both ends are INTERNAL
 *   (transfers) or both external (direct supplier→customer trade).
 * - Aggregation sums ONLY normalizedQuantity (the variant's inventory UOM) —
 *   raw source units are never mixed (Integrity Gate #1/#2).
 * - Negative computed stock is ALLOWED and flagged `negative: true`
 *   (warning semantics); with the `inventory.negative_stock_policy` setting
 *   = BLOCK, writes that would push an INTERNAL location negative are
 *   rejected (see NormalizationService.assertNegativePolicy).
 * - Warehouses: at most ONE default per company, enforced like the UOM
 *   base-unit rule (service ConflictError; promoting a second default is a
 *   409, demoting is allowed, explicit set-default flips the others).
 */
@Injectable()
export class InventoryService {
  private normalizationInstance: NormalizationService | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    // Optional so hand-built test instances keep working; InventoryModule
    // provides NormalizationService directly.
    @Optional() @Inject(NormalizationService) normalization?: NormalizationService,
  ) {
    this.normalizationInstance = normalization;
  }

  /** Normalization seam (lazy fallback for hand-built fixture instances). */
  get normalization(): NormalizationService {
    if (!this.normalizationInstance) {
      this.normalizationInstance = new NormalizationService(this.prisma);
    }
    return this.normalizationInstance;
  }

  // ───────────────── default warehouse resolution ─────────────────

  /**
   * Resolve the company's default warehouse (loading WAREHOUSE routes and
   * goods-receipt destinations land here). Preference: the isDefault
   * warehouse → the oldest active warehouse → create the seeded MAIN
   * warehouse idempotently (P2002 race → re-fetch). Never throws for a live
   * company.
   */
  async ensureDefaultWarehouse(tx: Client, companyId: string): Promise<WarehouseRef> {
    const existing = await tx.warehouse.findFirst({
      where: { companyId, active: true, isDefault: true },
      select: { id: true, code: true, nameFa: true },
    });
    if (existing) return existing;

    const fallback = await tx.warehouse.findFirst({
      where: { companyId, active: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, code: true, nameFa: true },
    });
    if (fallback) return fallback;

    try {
      const created = await tx.warehouse.create({
        data: {
          companyId,
          code: DEFAULT_WAREHOUSE_CODE,
          nameFa: DEFAULT_WAREHOUSE_NAME_FA,
          isDefault: true,
        },
        select: { id: true, code: true, nameFa: true },
      });
      return created;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await tx.warehouse.findFirstOrThrow({
          where: { companyId, code: DEFAULT_WAREHOUSE_CODE },
          select: { id: true, code: true, nameFa: true },
        });
        return raced;
      }
      throw error;
    }
  }

  // ───────────────── stock locations (Integrity Gate #6) ─────────────────

  /**
   * Idempotently ensure the location skeleton exists for a company: the
   * default SUPPLIER / CUSTOMER locations (direct trade endpoints) and one
   * INTERNAL location per warehouse (`LOC-` + warehouse code). Safe to call
   * repeatedly — everything is an upsert on (companyId, code).
   */
  async ensureLocations(companyId: string, tx?: Client): Promise<void> {
    const db = tx ?? this.prisma;
    await db.stockLocation.upsert({
      where: { companyId_code: { companyId, code: DEFAULT_SUPPLIER_LOCATION_CODE } },
      create: {
        companyId,
        type: StockLocationType.SUPPLIER,
        code: DEFAULT_SUPPLIER_LOCATION_CODE,
        nameFa: 'تامین‌کننده (مقصد مستقیم)',
      },
      update: {},
    });
    await db.stockLocation.upsert({
      where: { companyId_code: { companyId, code: DEFAULT_CUSTOMER_LOCATION_CODE } },
      create: {
        companyId,
        type: StockLocationType.CUSTOMER,
        code: DEFAULT_CUSTOMER_LOCATION_CODE,
        nameFa: 'مشتری (مقصد مستقیم)',
      },
      update: {},
    });
    const warehouses = await db.warehouse.findMany({ where: { companyId }, select: { id: true, code: true, nameFa: true } });
    for (const warehouse of warehouses) {
      await db.stockLocation.upsert({
        where: { companyId_code: { companyId, code: `LOC-${warehouse.code}` } },
        create: {
          companyId,
          type: StockLocationType.INTERNAL,
          warehouseId: warehouse.id,
          code: `LOC-${warehouse.code}`,
          nameFa: warehouse.nameFa,
        },
        update: {},
      });
    }
  }

  /** Paginated location list (grid + pickers). */
  async listLocations(
    companyId: string,
    query: { type?: StockLocationType; warehouseId?: string; active?: boolean },
  ) {
    return this.prisma.stockLocation.findMany({
      where: {
        companyId,
        type: query.type,
        warehouseId: query.warehouseId,
        ...(query.active === undefined ? {} : { active: query.active }),
      },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
      include: {
        warehouse: { select: { id: true, code: true, nameFa: true } },
        party: { select: { id: true, nameFa: true } },
      },
    });
  }

  /**
   * Find-or-create a location by SEMANTICS (never by raw id from the
   * caller): INTERNAL locations are keyed on the warehouse (`LOC-` + code),
   * external SUPPLIER/CUSTOMER locations on the party (`SUPPLIER-`/`CUSTOMER-`
   * + partyId) with company-wide defaults when no party is known.
   */
  async resolveLocation(tx: Client, companyId: string, input: ResolveLocationInput) {
    if (input.type === StockLocationType.INTERNAL) {
      if (!input.warehouseId) {
        throw new ValidationError(INVENTORY_MESSAGES.warehouseRequired, { type: input.type });
      }
      const warehouse = await tx.warehouse.findFirst({
        where: { id: input.warehouseId, companyId },
        select: { id: true, code: true, nameFa: true },
      });
      if (!warehouse) throw new NotFoundError('Warehouse not found', { warehouseId: input.warehouseId });
      const code = `LOC-${warehouse.code}`;
      return this.findOrCreateLocation(tx, companyId, {
        type: StockLocationType.INTERNAL,
        code,
        nameFa: warehouse.nameFa,
        warehouseId: warehouse.id,
      });
    }
    if (input.type === StockLocationType.SUPPLIER || input.type === StockLocationType.CUSTOMER) {
      let code: string;
      let nameFa: string;
      if (input.partyId) {
        const party = await tx.party.findFirst({
          where: { id: input.partyId, companyId },
          select: { id: true, nameFa: true },
        });
        if (!party) throw new NotFoundError('Party not found', { partyId: input.partyId });
        code = `${input.type === StockLocationType.SUPPLIER ? 'SUPPLIER' : 'CUSTOMER'}-${party.id}`;
        nameFa = input.type === StockLocationType.SUPPLIER ? `تامین‌کننده ${party.nameFa}` : `مشتری ${party.nameFa}`;
      } else {
        code = input.type === StockLocationType.SUPPLIER ? DEFAULT_SUPPLIER_LOCATION_CODE : DEFAULT_CUSTOMER_LOCATION_CODE;
        nameFa = input.type === StockLocationType.SUPPLIER ? 'تامین‌کننده (مقصد مستقیم)' : 'مشتری (مقصد مستقیم)';
      }
      return this.findOrCreateLocation(tx, companyId, { type: input.type, code, nameFa, partyId: input.partyId ?? null });
    }
    throw new ValidationError(INVENTORY_MESSAGES.invalidLocationType, { type: input.type });
  }

  private async findOrCreateLocation(
    tx: Client,
    companyId: string,
    data: {
      type: StockLocationType;
      code: string;
      nameFa: string;
      warehouseId?: string | null;
      partyId?: string | null;
    },
  ) {
    const existing = await tx.stockLocation.findUnique({
      where: { companyId_code: { companyId, code: data.code } },
    });
    if (existing) return existing;
    try {
      return await tx.stockLocation.create({
        data: {
          companyId,
          type: data.type,
          code: data.code,
          nameFa: data.nameFa,
          warehouseId: data.warehouseId ?? null,
          partyId: data.partyId ?? null,
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const raced = await tx.stockLocation.findUniqueOrThrow({
          where: { companyId_code: { companyId, code: data.code } },
        });
        return raced;
      }
      throw error;
    }
  }

  // ───────────────── computed stock (location semantics, #7) ─────────────────

  /**
   * One aggregate query (no N+1 — the grid MUST stay one round trip):
   * per-variant SUM over location semantics of normalizedQuantity with
   * display joins and a COUNT(*) OVER() window (evaluated post-GROUP BY, so
   * `total` is the number of variant rows for the whole filter — no second
   * query). With a warehouseId filter the sums are that warehouse's inbound
   * legs (arrivals) minus its outbound legs; without it, company physical
   * stock (INTERNAL only).
   */
  async stock(companyId: string, query: StockQueryDto): Promise<Paginated<unknown>> {
    const search = query.search?.trim();
    const conditions = [Prisma.sql`sm.company_id = ${companyId}::uuid`];
    if (query.warehouseId) {
      conditions.push(
        Prisma.sql`(sl.warehouse_id = ${query.warehouseId}::uuid OR dl.warehouse_id = ${query.warehouseId}::uuid)`,
      );
    }
    if (query.variantId) {
      conditions.push(Prisma.sql`sm.product_variant_id = ${query.variantId}::uuid`);
    }
    if (query.categoryId) {
      conditions.push(Prisma.sql`pt.category_id = ${query.categoryId}::uuid`);
    }
    if (search) {
      const like = `%${search}%`;
      conditions.push(
        Prisma.sql`(pv.name_fa ILIKE ${like} OR pv.name_en ILIKE ${like} OR pv.sku ILIKE ${like} OR pt.name_fa ILIKE ${like} OR pt.name_en ILIKE ${like})`,
      );
    }
    const where = Prisma.join(conditions, ' AND ');

    // Company total (#7): INTERNAL-only deltas. Per-warehouse: that
    // warehouse's arrivals from elsewhere minus departures elsewhere.
    const stockExpression = query.warehouseId
      ? Prisma.sql`SUM(CASE
          WHEN dl.warehouse_id = ${query.warehouseId}::uuid AND (sl.warehouse_id IS DISTINCT FROM dl.warehouse_id) THEN sm.normalized_quantity
          WHEN sl.warehouse_id = ${query.warehouseId}::uuid AND (sl.warehouse_id IS DISTINCT FROM dl.warehouse_id) THEN -sm.normalized_quantity
          ELSE 0 END)`
      : Prisma.sql`SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
          ELSE 0 END)`;

    const limit = Math.min(Math.max(query.take, 1), 100);
    const offset = Math.max(query.skip, 0);

    const rows = await this.prisma.$queryRaw<
      {
        variant_id: string;
        sku: string;
        variant_name_fa: string;
        variant_name_en: string | null;
        template_name_fa: string;
        category_name_fa: string | null;
        brand_name_fa: string | null;
        uom_symbol: string | null;
        stock: Prisma.Decimal;
        total: bigint;
      }[]
    >(Prisma.sql`
      SELECT
        pv.id                AS variant_id,
        pv.sku               AS sku,
        pv.name_fa           AS variant_name_fa,
        pv.name_en           AS variant_name_en,
        pt.name_fa           AS template_name_fa,
        pc.name_fa           AS category_name_fa,
        b.name_fa            AS brand_name_fa,
        inv.symbol           AS uom_symbol,
        ${stockExpression}   AS stock,
        COUNT(*) OVER()      AS total
      FROM stock_movements sm
      JOIN product_variants pv   ON pv.id = sm.product_variant_id
      JOIN product_templates pt  ON pt.id = pv.template_id
      JOIN stock_locations sl    ON sl.id = sm.source_location_id
      JOIN stock_locations dl    ON dl.id = sm.destination_location_id
      LEFT JOIN product_categories pc ON pc.id = pt.category_id
      LEFT JOIN brands b              ON b.id = pt.brand_id
      LEFT JOIN uoms inv              ON inv.id = COALESCE(pv.inventory_uom_id, pv.default_uom_id)
      WHERE ${where}
      GROUP BY pv.id, pv.sku, pv.name_fa, pv.name_en, pt.name_fa, pc.name_fa, b.name_fa, inv.symbol
      ORDER BY stock DESC, pv.sku ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return {
      items: rows.map((row) => ({
        variant: {
          id: row.variant_id,
          sku: row.sku,
          nameFa: row.variant_name_fa,
          nameEn: row.variant_name_en,
          templateNameFa: row.template_name_fa,
          categoryNameFa: row.category_name_fa,
          brandNameFa: row.brand_name_fa,
          uomSymbol: row.uom_symbol,
        },
        stock: row.stock,
        negative: row.stock.isNegative(),
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ───────────────── movement ledger ─────────────────

  /**
   * Movement ledger with the FULL integrity picture: the verbatim source
   * quantity/UOM pair AND the normalized quantity/inventory-UOM pair, plus
   * both location endpoints (from → to) — the audit story of every unit.
   */
  async movements(companyId: string, query: MovementQueryDto): Promise<Paginated<unknown>> {
    const where: Prisma.StockMovementWhereInput = {
      companyId,
      warehouseId: query.warehouseId,
      productVariantId: query.variantId,
      sourceEntityType: query.sourceEntityType,
      sourceEntityId: query.sourceEntityId,
      ...(query.from || query.to
        ? {
            movementDate: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.stockMovement.findMany({
        where,
        orderBy: { movementDate: 'desc' },
        skip: query.skip,
        take: query.take,
        include: {
          warehouse: { select: { id: true, code: true, nameFa: true } },
          productVariant: { select: { id: true, sku: true, nameFa: true } },
          sourceUom: { select: { id: true, symbol: true } },
          inventoryUom: { select: { id: true, symbol: true } },
          sourceLocation: { select: { id: true, code: true, type: true, nameFa: true } },
          destinationLocation: { select: { id: true, code: true, type: true, nameFa: true } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return {
      items: items.map((movement) => ({
        id: movement.id,
        companyId: movement.companyId,
        direction: movement.direction,
        movementDate: movement.movementDate,
        sourceEntityType: movement.sourceEntityType,
        sourceEntityId: movement.sourceEntityId,
        idempotencyKey: movement.idempotencyKey,
        reversalOfMovementId: movement.reversalOfMovementId,
        warehouse: movement.warehouse,
        productVariant: movement.productVariant,
        source: {
          quantity: movement.sourceQuantity,
          uom: movement.sourceUom,
          location: movement.sourceLocation,
        },
        normalized: {
          quantity: movement.normalizedQuantity,
          uom: movement.inventoryUom,
          location: movement.destinationLocation,
        },
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  // ───────────────── internal warehouse→warehouse transfer ─────────────────

  /**
   * The single non-operational movement allowed (REQUIREMENTS §21): one
   * INTERNAL(from) → INTERNAL(to) movement. Company total is UNCHANGED by
   * construction (both ends internal); per-warehouse stocks move in opposite
   * directions. The BLOCK negative policy applies to the losing warehouse.
   */
  async transfer(
    companyId: string,
    dto: CreateTransferDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    if (dto.fromWarehouseId === dto.toWarehouseId) {
      throw new ValidationError(INVENTORY_MESSAGES.transferSameWarehouse, { warehouseId: dto.fromWarehouseId });
    }
    if (!(D(dto.quantity).gt(0))) {
      throw new ValidationError(INVENTORY_MESSAGES.quantityPositive, { quantity: dto.quantity });
    }

    return this.prisma.$transaction(
      async (tx) => {
        const [from, to] = await Promise.all([
          tx.warehouse.findFirst({ where: { id: dto.fromWarehouseId, companyId }, select: { id: true } }),
          tx.warehouse.findFirst({ where: { id: dto.toWarehouseId, companyId }, select: { id: true } }),
        ]);
        if (!from) throw new NotFoundError('Warehouse not found', { warehouseId: dto.fromWarehouseId });
        if (!to) throw new NotFoundError('Warehouse not found', { warehouseId: dto.toWarehouseId });

        const variant = await tx.productVariant.findFirst({
          where: { id: dto.variantId, companyId },
          select: { id: true },
        });
        if (!variant) throw new NotFoundError('Product variant not found', { variantId: dto.variantId });
        if (dto.uomId) {
          const uom = await tx.uom.findFirst({ where: { id: dto.uomId, companyId, active: true }, select: { id: true } });
          if (!uom) throw new ValidationError(INVENTORY_MESSAGES.uomNotInCompany, { uomId: dto.uomId });
        }

        const source = await this.resolveLocation(tx, companyId, { type: 'INTERNAL', warehouseId: from.id });
        const destination = await this.resolveLocation(tx, companyId, { type: 'INTERNAL', warehouseId: to.id });

        const quantity = D(dto.quantity);
        // The BLOCK negative-stock policy is enforced inside the movement
        // write seam (source = the losing INTERNAL location).

        const inserted = await this.normalization.insertStockMovement(tx, {
          companyId,
          productVariantId: dto.variantId,
          quantity,
          uomId: dto.uomId,
          direction: 'OUT',
          sourceLocationId: source.id,
          destinationLocationId: destination.id,
          warehouseId: from.id,
          movementDate: new Date(),
          sourceEntityType: 'TRANSFER',
          sourceEntityId: to.id, // no transfer entity — reference the destination warehouse
          idempotencyKey: `transfer:${companyId}:${randomUUID()}`,
          createdBy: actor.id,
        });

        await this.auditService.recordTx(tx, {
          entityType: 'stock_transfer',
          entityId: destination.id,
          action: 'TRANSFER',
          companyId,
          actor,
          newValues: {
            variantId: dto.variantId,
            quantity: quantity.toString(),
            uomId: dto.uomId,
            fromLocationId: source.id,
            toLocationId: destination.id,
            movementInserted: inserted,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });

        return {
          inserted,
          sourceLocationId: source.id,
          destinationLocationId: destination.id,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  // ───────────────── warehouses CRUD ─────────────────

  async listWarehouses(companyId: string, active?: boolean): Promise<Warehouse[]> {
    return this.prisma.warehouse.findMany({
      where: { companyId, ...(active === undefined ? {} : { active }) },
      orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
    });
  }

  async getWarehouse(companyId: string, id: string): Promise<Warehouse> {
    const warehouse = await this.prisma.warehouse.findFirst({ where: { id, companyId } });
    if (!warehouse) throw new NotFoundError('Warehouse not found', { id });
    return warehouse;
  }

  async createWarehouse(
    companyId: string,
    dto: CreateWarehouseDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Warehouse> {
    const warehouse = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await this.assertNoDefault(tx, companyId);
      }
      return tx.warehouse.create({
        data: {
          companyId,
          code: dto.code,
          nameFa: dto.nameFa,
          nameEn: dto.nameEn,
          isDefault: dto.isDefault ?? false,
        },
      });
    });
    await this.auditService.record({
      entityType: 'warehouse',
      entityId: warehouse.id,
      action: AuditAction.CREATE,
      companyId,
      actor,
      newValues: { code: warehouse.code, nameFa: warehouse.nameFa, isDefault: warehouse.isDefault },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return warehouse;
  }

  async updateWarehouse(
    companyId: string,
    id: string,
    dto: UpdateWarehouseDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Warehouse> {
    const existing = await this.getWarehouse(companyId, id);
    const warehouse = await this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await this.assertNoDefault(tx, companyId, existing.id);
      }
      return tx.warehouse.update({
        where: { id: existing.id },
        data: {
          code: dto.code,
          nameFa: dto.nameFa,
          ...(dto.nameEn === undefined ? {} : { nameEn: dto.nameEn }),
          ...(dto.isDefault === undefined ? {} : { isDefault: dto.isDefault }),
          ...(dto.active === undefined ? {} : { active: dto.active }),
        },
      });
    });
    await this.auditService.record({
      entityType: 'warehouse',
      entityId: warehouse.id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      oldValues: {
        code: existing.code,
        nameFa: existing.nameFa,
        isDefault: existing.isDefault,
        active: existing.active,
      },
      newValues: { code: warehouse.code, nameFa: warehouse.nameFa, isDefault: warehouse.isDefault, active: warehouse.active },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return warehouse;
  }

  /** Flip: the target becomes the ONLY default (others cleared first). */
  async setDefaultWarehouse(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<Warehouse> {
    const existing = await this.getWarehouse(companyId, id);
    const warehouse = await this.prisma.$transaction(async (tx) => {
      await tx.warehouse.updateMany({ where: { companyId, isDefault: true }, data: { isDefault: false } });
      return tx.warehouse.update({ where: { id: existing.id }, data: { isDefault: true } });
    });
    await this.auditService.record({
      entityType: 'warehouse',
      entityId: warehouse.id,
      action: AuditAction.UPDATE,
      companyId,
      actor,
      newValues: { isDefault: true },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return warehouse;
  }

  async deleteWarehouse(
    companyId: string,
    id: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.getWarehouse(companyId, id);
    const inUse = await this.prisma.stockMovement.count({ where: { warehouseId: existing.id } });
    if (inUse > 0) {
      throw new ConflictError(INVENTORY_MESSAGES.inUse, { id, movementCount: inUse });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.warehouse.delete({ where: { id: existing.id } });
      await this.auditService.recordTx(tx, {
        entityType: 'warehouse',
        entityId: existing.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: { code: existing.code, nameFa: existing.nameFa },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }

  /** At-most-one default (UOM base-unit precedent). */
  private async assertNoDefault(
    tx: Prisma.TransactionClient,
    companyId: string,
    excludeId?: string,
  ): Promise<void> {
    const current = await tx.warehouse.findFirst({
      where: { companyId, isDefault: true, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, code: true },
    });
    if (current) {
      throw new ConflictError(INVENTORY_MESSAGES.defaultExists, { existingDefaultId: current.id });
    }
  }
}
