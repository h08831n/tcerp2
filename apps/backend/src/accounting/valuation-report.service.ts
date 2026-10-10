import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Inventory valuation (docs/06 §5): quantity/value from stock movement cost
 * snapshots, aggregated per INTERNAL location; company total = Σ internal.
 * Per-variant history with running quantity valued at each movement's own
 * cost snapshot (specific identification — never re-valued retroactively).
 */
@Injectable()
export class ValuationReportService {
  constructor(private readonly prisma: PrismaService) {}

  /** INTERNAL location ids for the company. */
  private async internalLocationIds(companyId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM stock_locations WHERE company_id = ${companyId}::uuid AND type = 'INTERNAL' AND active`;
    return rows.map((r) => r.id);
  }

  async valuation(
    companyId: string,
    opts: { warehouseId?: string; categoryId?: string; variantId?: string; search?: string; page?: number; pageSize?: number },
  ) {
    const locationIds = await this.internalLocationIds(companyId);
    if (locationIds.length === 0) {
      return { rows: [], totals: { totalValue: new Prisma.Decimal(0) }, page: 1, pageSize: 0, total: 0 };
    }
    const ids = Prisma.join(locationIds.map((id) => Prisma.sql`${id}::uuid`), ',');
    const page = Math.max(1, opts.page ?? 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 25, 1), 200);
    const search = opts.search?.trim();

    const rows = await this.prisma.$queryRaw<
      Array<{
        variant_id: string;
        sku: string;
        variant_name_fa: string;
        template_name_fa: string;
        category_name_fa: string | null;
        brand_name_fa: string | null;
        warehouse_name_fa: string | null;
        uom_symbol: string | null;
        quantity: Prisma.Decimal;
        unit_cost: Prisma.Decimal | null;
        total_value: Prisma.Decimal;
        total: bigint;
      }>
    >`
      SELECT variant_id, sku, variant_name_fa, template_name_fa, category_name_fa, brand_name_fa,
             warehouse_name_fa, uom_symbol,
             SUM(quantity) AS quantity,
             CASE WHEN SUM(quantity) = 0 THEN NULL
                  ELSE SUM(total_value) / SUM(quantity) END AS unit_cost,
             SUM(total_value) AS total_value,
             COUNT(*) OVER() AS total
      FROM (
        SELECT m.product_variant_id AS variant_id,
               pv.sku AS sku, pv.name_fa AS variant_name_fa,
               pt.name_fa AS template_name_fa,
               pc.name_fa AS category_name_fa, b.name_fa AS brand_name_fa,
               w.name_fa AS warehouse_name_fa, uom.symbol AS uom_symbol,
               CASE WHEN m."destination_location_id" IN (${ids})
                    THEN m.normalized_quantity ELSE -m.normalized_quantity END AS quantity,
               CASE WHEN m."destination_location_id" IN (${ids})
                    THEN m.normalized_quantity * COALESCE(m.unit_cost_snapshot, 0)
                    ELSE -(m.normalized_quantity * COALESCE(m.unit_cost_snapshot, 0)) END AS total_value
        FROM stock_movements m
        JOIN product_variants pv ON pv.id = m.product_variant_id
        JOIN product_templates pt ON pt.id = pv.template_id
        LEFT JOIN product_categories pc ON pc.id = pt.category_id
        LEFT JOIN brands b ON b.id = pt.brand_id
        LEFT JOIN uoms uom ON uom.id = pv.inventory_uom_id
        LEFT JOIN stock_locations dl ON dl.id = m.destination_location_id
        LEFT JOIN stock_locations sl ON sl.id = m.source_location_id
        LEFT JOIN warehouses w ON w.id = dl.warehouse_id
        WHERE m.company_id = ${companyId}::uuid
          AND (dl.type = 'INTERNAL' OR sl.type = 'INTERNAL')
          ${opts.warehouseId ? Prisma.sql`AND (dl.warehouse_id = ${opts.warehouseId}::uuid OR sl.warehouse_id = ${opts.warehouseId}::uuid)` : Prisma.empty}
          ${opts.categoryId ? Prisma.sql`AND pt.category_id = ${opts.categoryId}::uuid` : Prisma.empty}
          ${opts.variantId ? Prisma.sql`AND m.product_variant_id = ${opts.variantId}::uuid` : Prisma.empty}
          ${search ? Prisma.sql`AND (pv.name_fa ILIKE ${'%' + search + '%'} OR pv.sku ILIKE ${'%' + search + '%'} OR pt.name_fa ILIKE ${'%' + search + '%'})` : Prisma.empty}
      ) per_movement
      GROUP BY variant_id, sku, variant_name_fa, template_name_fa, category_name_fa, brand_name_fa, warehouse_name_fa, uom_symbol
      ORDER BY total_value DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;

    const total = rows.length > 0 ? Number(rows[0].total) : 0;
    return {
      rows: rows.map((r) => ({
        variant: {
          id: r.variant_id,
          sku: r.sku,
          nameFa: r.variant_name_fa,
        },
        templateNameFa: r.template_name_fa,
        categoryNameFa: r.category_name_fa,
        brandNameFa: r.brand_name_fa,
        warehouseNameFa: r.warehouse_name_fa,
        uomSymbol: r.uom_symbol,
        quantity: r.quantity,
        unitCost: r.unit_cost,
        totalValue: r.total_value,
        negative: r.quantity.lt(0),
      })),
      totals: {
        totalValue: rows.reduce((s, r) => s.plus(r.total_value), new Prisma.Decimal(0)),
      },
      page,
      pageSize,
      total,
    };
  }

  /** Per-variant movement history with running quantity/value. */
  async variantHistory(companyId: string, variantId: string) {
    const movements = await this.prisma.stockMovement.findMany({
      where: { companyId, productVariantId: variantId },
      orderBy: [{ movementDate: 'asc' }, { createdAt: 'asc' }],
      include: {
        sourceLocation: { select: { nameFa: true, type: true } },
        destinationLocation: { select: { nameFa: true, type: true } },
      },
    });
    let running = new Prisma.Decimal(0);
    const rows = movements.map((m) => {
      const internalIn = m.destinationLocation.type === 'INTERNAL';
      const internalOut = m.sourceLocation.type === 'INTERNAL';
      if (internalIn && !internalOut) running = running.plus(m.normalizedQuantity);
      else if (internalOut && !internalIn) running = running.minus(m.normalizedQuantity);
      return {
        movementDate: m.movementDate,
        direction: m.direction,
        sourceQuantity: m.sourceQuantity,
        sourceUom: m.sourceUomId,
        normalizedQuantity: m.normalizedQuantity,
        uomSymbol: null,
        unitCost: m.unitCostSnapshot,
        totalCost: m.totalCostSnapshot,
        from: m.sourceLocation?.nameFa ?? null,
        to: m.destinationLocation?.nameFa ?? null,
        sourceEntityType: m.sourceEntityType,
        sourceEntityId: m.sourceEntityId,
        runningQuantity: running,
      };
    });
    return { variantId, rows, closingQuantity: running };
  }
}
