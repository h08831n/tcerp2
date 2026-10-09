import { Injectable } from '@nestjs/common';
import { Prisma, Warehouse } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { Paginated } from '../common/dto/pagination.dto';
import {
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
} as const;

export const DEFAULT_WAREHOUSE_CODE = 'MAIN';
export const DEFAULT_WAREHOUSE_NAME_FA = 'انبار مرکزی';

interface WarehouseRef {
  id: string;
  code: string;
  nameFa: string;
}

/**
 * Inventory (Phase 6, REQUIREMENTS §21 + domain boundaries §4-6):
 *
 * - StockMovements are generated ONLY from operational documents — confirmed
 *   Loadings (OUT) and purchase receiving (IN). No manual stock entry exists
 *   and none may be added (boundary §5).
 * - Computed stock per variant = SUM(IN) − SUM(OUT) over `stock_movements`,
 *   resolved in ONE aggregate SQL query (group + joins + COUNT(*) OVER() for
 *   pagination). Movements store the quantity in the SOURCE line's uom; the
 *   stock row reports the variant's default uom symbol as the reference unit
 *   (cross-uom normalization is intentionally NOT attempted in Phase 6).
 * - Negative computed stock is ALLOWED and flagged `negative: true` (warning
 *   semantics — the business decides later; nothing is blocked).
 * - Warehouses: at most ONE default per company, enforced like the UOM
 *   base-unit rule (service ConflictError; promoting a second default is a
 *   409, demoting is allowed, explicit set-default flips the others).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ───────────────── default warehouse resolution ─────────────────

  /**
   * Resolve the company's default warehouse (loading.warehouseId null and
   * purchase receiving both land here). Preference: the isDefault warehouse →
   * the oldest active warehouse → create the seeded MAIN warehouse
   * idempotently (P2002 race → re-fetch). Never throws for a live company.
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

  // ───────────────── computed stock ─────────────────

  /**
   * One aggregate query: per-variant SUM(IN) − SUM(OUT) with display joins
   * and a COUNT(*) OVER() window (evaluated post-GROUP BY, so `total` is the
   * number of variant rows for the whole filter — no second query).
   */
  async stock(companyId: string, query: StockQueryDto): Promise<Paginated<unknown>> {
    const search = query.search?.trim();
    const conditions = [Prisma.sql`sm.company_id = ${companyId}::uuid`];
    if (query.warehouseId) {
      conditions.push(Prisma.sql`sm.warehouse_id = ${query.warehouseId}::uuid`);
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
        uom.symbol           AS uom_symbol,
        SUM(CASE WHEN sm.direction = 'IN' THEN sm.quantity ELSE -sm.quantity END) AS stock,
        COUNT(*) OVER()      AS total
      FROM stock_movements sm
      JOIN product_variants pv   ON pv.id = sm.product_variant_id
      JOIN product_templates pt  ON pt.id = pv.template_id
      LEFT JOIN product_categories pc ON pc.id = pt.category_id
      LEFT JOIN brands b              ON b.id = pt.brand_id
      LEFT JOIN uoms uom              ON uom.id = pv.default_uom_id
      WHERE ${where}
      GROUP BY pv.id, pv.sku, pv.name_fa, pv.name_en, pt.name_fa, pc.name_fa, b.name_fa, uom.symbol
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
          uom: { select: { id: true, symbol: true } },
        },
      }),
      this.prisma.stockMovement.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
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
