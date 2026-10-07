import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../common/errors';
import { assertSupplier } from '../common/utils/party-roles';
import { D, roundMoney } from '../common/utils/money';
import { RequestContext } from '../auth/auth.service';
import { AddOfferDto, UpdateOfferDto } from './price-request.dto';

/**
 * Supplier offers on a price request line (REQUIREMENTS §15): several
 * suppliers per line (34,300 / 34,450 / 34,250 …). The FIRST offer moves the
 * request OPEN → OFFERED. Offers are editable/deletable by their owner until
 * the request is converted/closed.
 *
 * Daily-lowest intelligence (§15 Supplier Intelligence): averages are NOT
 * the signal — the system records WHICH supplier was the daily cheapest per
 * (day, product, uom) and reports "in the last N days supplier X was the
 * daily lowest K times". Comparison happens WITHIN the same uom group;
 * cross-uom normalization lands with Phase 5 (daily pricing engine). Ties
 * return ALL co-lowest offers.
 */

export interface DailyLowestRow {
  day: string;
  productVariantId: string;
  uomId: string;
  offers: {
    id: string;
    supplierPartyId: string;
    supplierNameFa: string;
    offeredPrice: string;
  }[];
}

interface RankedRow {
  id: string;
  supplier_party_id: string;
  supplier_name_fa: string | null;
  offered_price: Prisma.Decimal;
  uom_id: string;
  product_variant_id: string;
  day: Date;
  rnk: BigInt | number;
}

@Injectable()
export class SupplierOffersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  private async loadLineWithRequest(companyId: string, priceRequestLineId: string) {
    const line = await this.prisma.priceRequestLine.findFirst({
      where: { id: priceRequestLineId, companyId },
      include: { priceRequest: { select: { id: true, status: true } } },
    });
    if (!line) throw new NotFoundError('Price request line not found', { priceRequestLineId });
    return line;
  }

  private assertEditable(status: string): void {
    if (status === 'CONVERTED' || status === 'CLOSED') {
      throw new ConflictError('PRICE_REQUEST_CONVERTED', { status });
    }
  }

  async addOffer(
    companyId: string,
    priceRequestLineId: string,
    dto: AddOfferDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const line = await this.loadLineWithRequest(companyId, priceRequestLineId);
    this.assertEditable(line.priceRequest.status);

    const offer = await this.prisma.$transaction(async (tx) => {
      await assertSupplier(tx, companyId, dto.supplierPartyId);

      if (dto.uomId) {
        const uom = await tx.uom.findFirst({ where: { id: dto.uomId, companyId, active: true }, select: { id: true } });
        if (!uom) throw new NotFoundError('Uom not found', { uomId: dto.uomId });
      }

      const row = await tx.supplierOffer.create({
        data: {
          companyId,
          priceRequestLineId: line.id,
          supplierPartyId: dto.supplierPartyId,
          offeredPrice: roundMoney(D(dto.offeredPrice)),
          uomId: dto.uomId ?? line.uomId,
          paymentTerms: dto.paymentTerms,
          deliveryTime: dto.deliveryTime,
          notes: dto.notes,
          offeredAt: dto.offeredAt ? new Date(dto.offeredAt) : new Date(),
          createdBy: actor.id,
        },
      });

      // The first offer moves the request OPEN → OFFERED.
      await tx.priceRequest.updateMany({
        where: { id: line.priceRequest.id, companyId, status: 'OPEN' },
        data: { status: 'OFFERED' },
      });

      await this.auditService.recordTx(tx, {
        entityType: 'supplier_offer',
        entityId: row.id,
        action: AuditAction.CREATE,
        companyId,
        actor,
        newValues: {
          priceRequestLineId: row.priceRequestLineId,
          supplierPartyId: row.supplierPartyId,
          offeredPrice: row.offeredPrice,
          uomId: row.uomId,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
    return offer;
  }

  async updateOffer(
    companyId: string,
    priceRequestLineId: string,
    offerId: string,
    dto: UpdateOfferDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const line = await this.loadLineWithRequest(companyId, priceRequestLineId);
    this.assertEditable(line.priceRequest.status);

    const existing = await this.prisma.supplierOffer.findFirst({
      where: { id: offerId, priceRequestLineId: line.id, companyId },
    });
    if (!existing) throw new NotFoundError('Supplier offer not found', { offerId });
    if (existing.createdBy !== actor.id) {
      throw new ForbiddenError('NOT_OFFER_OWNER', { offerId });
    }

    return this.prisma.$transaction(async (tx) => {
      const row = await tx.supplierOffer.update({
        where: { id: existing.id },
        data: {
          offeredPrice: dto.offeredPrice !== undefined ? roundMoney(D(dto.offeredPrice)) : undefined,
          uomId: dto.uomId,
          paymentTerms: dto.paymentTerms,
          deliveryTime: dto.deliveryTime,
          notes: dto.notes,
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'supplier_offer',
        entityId: row.id,
        action: AuditAction.UPDATE,
        companyId,
        actor,
        oldValues: { offeredPrice: existing.offeredPrice, notes: existing.notes },
        newValues: { offeredPrice: row.offeredPrice, notes: row.notes },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    });
  }

  async deleteOffer(
    companyId: string,
    priceRequestLineId: string,
    offerId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const line = await this.loadLineWithRequest(companyId, priceRequestLineId);
    this.assertEditable(line.priceRequest.status);

    const existing = await this.prisma.supplierOffer.findFirst({
      where: { id: offerId, priceRequestLineId: line.id, companyId },
    });
    if (!existing) throw new NotFoundError('Supplier offer not found', { offerId });
    if (existing.createdBy !== actor.id) {
      throw new ForbiddenError('NOT_OFFER_OWNER', { offerId });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.supplierOffer.delete({ where: { id: existing.id } });
      // Back to OPEN when the last offer disappears.
      const remaining = await tx.supplierOffer.count({
        where: { priceRequestLineId: { in: await this.lineIds(tx, line.priceRequest.id) } },
      });
      if (remaining === 0) {
        await tx.priceRequest.updateMany({
          where: { id: line.priceRequest.id, companyId, status: 'OFFERED' },
          data: { status: 'OPEN' },
        });
      }
      await this.auditService.recordTx(tx, {
        entityType: 'supplier_offer',
        entityId: existing.id,
        action: AuditAction.DELETE,
        companyId,
        actor,
        oldValues: {
          supplierPartyId: existing.supplierPartyId,
          offeredPrice: existing.offeredPrice,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }

  private async lineIds(tx: Prisma.TransactionClient, priceRequestId: string): Promise<string[]> {
    const rows = await tx.priceRequestLine.findMany({
      where: { priceRequestId },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  async listByLine(companyId: string, priceRequestLineId: string) {
    const line = await this.prisma.priceRequestLine.findFirst({
      where: { id: priceRequestLineId, companyId },
      select: { id: true },
    });
    if (!line) throw new NotFoundError('Price request line not found', { priceRequestLineId });
    return this.prisma.supplierOffer.findMany({
      where: { priceRequestLineId: line.id, companyId },
      include: { supplier: { select: { id: true, nameFa: true } }, uom: { select: { id: true, symbol: true } } },
      orderBy: { offeredPrice: 'asc' },
    });
  }

  // ───────────────────── daily-lowest intelligence (§15) ─────────────────────

  /**
   * For (variantId, day, uomId): the offer(s) with the MINIMUM offeredPrice.
   * Comparison is grouped by uomId — cross-uom comparison needs Phase 5 uom
   * normalization and is intentionally out of scope here. Ties: ALL
   * co-lowest offers are returned.
   */
  async getDailyLowest(
    companyId: string,
    options: { date?: string; variantId?: string } = {},
  ): Promise<DailyLowestRow[]> {
    const day = options.date ? dayStartOf(new Date(options.date)) : dayStartOf(new Date());
    const dayEnd = new Date(day.getTime() + 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<RankedRow[]>(Prisma.sql`
      SELECT * FROM (
        SELECT o.id,
               o.supplier_party_id,
               p.name_fa AS supplier_name_fa,
               o.offered_price,
               o.uom_id,
               l.product_variant_id,
               date_trunc('day', o.offered_at) AS day,
               RANK() OVER (
                 PARTITION BY date_trunc('day', o.offered_at), l.product_variant_id, o.uom_id
                 ORDER BY o.offered_price ASC
               ) AS rnk
        FROM supplier_offers o
        JOIN price_request_lines l ON l.id = o.price_request_line_id
        LEFT JOIN parties p ON p.id = o.supplier_party_id
        WHERE o.company_id = ${companyId}::uuid
          AND o.offered_at >= ${day} AND o.offered_at < ${dayEnd}
          ${options.variantId ? Prisma.sql`AND l.product_variant_id = ${options.variantId}::uuid` : Prisma.empty}
      ) ranked
      WHERE ranked.rnk = 1
      ORDER BY ranked.product_variant_id, ranked.uom_id, ranked.offered_price
    `);

    const groups = new Map<string, DailyLowestRow>();
    for (const row of rows) {
      const key = `${isoDay(row.day)}:${row.product_variant_id}:${row.uom_id}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          day: isoDay(row.day),
          productVariantId: row.product_variant_id,
          uomId: row.uom_id,
          offers: [],
        };
        groups.set(key, group);
      }
      group.offers.push({
        id: row.id,
        supplierPartyId: row.supplier_party_id,
        supplierNameFa: row.supplier_name_fa ?? row.supplier_party_id,
        offeredPrice: row.offered_price.toString(),
      });
    }
    return [...groups.values()];
  }

  /**
   * Supplier daily-lowest report: per (supplier, product, uom) how many days
   * in the last `days` the supplier was the daily lowest. E.g.
   * "Supplier X: in last 60 days was daily lowest 22 times."
   */
  async supplierLowestReport(companyId: string, days = 60) {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<Array<{
      supplier_party_id: string;
      supplier_name_fa: string | null;
      product_variant_id: string;
      variant_sku: string;
      variant_name_fa: string;
      uom_id: string;
      uom_symbol: string;
      days_lowest: BigInt | number;
    }>>(Prisma.sql`
      SELECT supplier_party_id, supplier_name_fa, product_variant_id, variant_sku, variant_name_fa,
             uom_id, uom_symbol, COUNT(*)::int AS days_lowest
      FROM (
        SELECT o.supplier_party_id,
               p.name_fa AS supplier_name_fa,
               l.product_variant_id,
               v.sku AS variant_sku,
               v.name_fa AS variant_name_fa,
               o.uom_id,
               u.symbol AS uom_symbol,
               date_trunc('day', o.offered_at) AS day,
               RANK() OVER (
                 PARTITION BY date_trunc('day', o.offered_at), l.product_variant_id, o.uom_id
                 ORDER BY o.offered_price ASC
               ) AS rnk
        FROM supplier_offers o
        JOIN price_request_lines l ON l.id = o.price_request_line_id
        JOIN product_variants v ON v.id = l.product_variant_id
        JOIN uoms u ON u.id = o.uom_id
        LEFT JOIN parties p ON p.id = o.supplier_party_id
        WHERE o.company_id = ${companyId}::uuid
          AND o.offered_at >= ${since}
      ) ranked
      WHERE ranked.rnk = 1
      GROUP BY supplier_party_id, supplier_name_fa, product_variant_id, variant_sku, variant_name_fa, uom_id, uom_symbol
      ORDER BY days_lowest DESC, supplier_name_fa NULLS LAST
    `);

    return {
      days,
      items: rows.map((r) => ({
        supplierPartyId: r.supplier_party_id,
        supplierNameFa: r.supplier_name_fa ?? r.supplier_party_id,
        productVariantId: r.product_variant_id,
        variantSku: r.variant_sku,
        variantNameFa: r.variant_name_fa,
        uomId: r.uom_id,
        uomSymbol: r.uom_symbol,
        daysLowest: Number(r.days_lowest),
      })),
    };
  }

  /**
   * Phase 5 cheapest-supplier report for ONE variant (§15 Supplier
   * Intelligence): per supplier how many DAYS in the last `days` it was the
   * daily-lowest offer for that variant (+ optional uom). Uses the same
   * RANK() pattern as supplierLowestReport — ties count for ALL co-lowest
   * suppliers (rnk = 1 keeps every minimum). No average price anywhere.
   */
  async cheapestReport(
    companyId: string,
    options: { variantId: string; days?: number; uomId?: string },
  ) {
    const days = options.days ?? 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await this.prisma.$queryRaw<Array<{
      supplier_party_id: string;
      supplier_name_fa: string | null;
      uom_id: string;
      uom_symbol: string;
      win_count: BigInt | number;
      last_won_at: Date | null;
    }>>(Prisma.sql`
      SELECT supplier_party_id, supplier_name_fa, uom_id, uom_symbol,
             COUNT(*)::int AS win_count,
             MAX(date_trunc('second', ranked.offered_at)) AS last_won_at
      FROM (
        SELECT o.supplier_party_id,
               p.name_fa AS supplier_name_fa,
               o.uom_id,
               u.symbol AS uom_symbol,
               o.offered_at,
               date_trunc('day', o.offered_at) AS day,
               RANK() OVER (
                 PARTITION BY date_trunc('day', o.offered_at), o.uom_id
                 ORDER BY o.offered_price ASC
               ) AS rnk
        FROM supplier_offers o
        JOIN price_request_lines l ON l.id = o.price_request_line_id
        JOIN uoms u ON u.id = o.uom_id
        LEFT JOIN parties p ON p.id = o.supplier_party_id
        WHERE o.company_id = ${companyId}::uuid
          AND l.product_variant_id = ${options.variantId}::uuid
          AND o.offered_at >= ${since}
          ${options.uomId ? Prisma.sql`AND o.uom_id = ${options.uomId}::uuid` : Prisma.empty}
      ) ranked
      WHERE ranked.rnk = 1
      GROUP BY supplier_party_id, supplier_name_fa, uom_id, uom_symbol
      ORDER BY win_count DESC, supplier_name_fa NULLS LAST
    `);

    return {
      variantId: options.variantId,
      days,
      ...(options.uomId ? { uomId: options.uomId } : {}),
      items: rows.map((r) => ({
        supplierPartyId: r.supplier_party_id,
        supplierNameFa: r.supplier_name_fa ?? r.supplier_party_id,
        uomId: r.uom_id,
        uomSymbol: r.uom_symbol,
        winCount: Number(r.win_count),
        lastWonAt: r.last_won_at ? new Date(r.last_won_at).toISOString() : null,
      })),
    };
  }
}

function dayStartOf(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
