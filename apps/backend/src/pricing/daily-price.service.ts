import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { DailyPrice, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { D, roundMoney } from '../common/utils/money';
import { randomUUID } from 'node:crypto';
import {
  BulkPriceUpdateDto,
  UpsertDailyPriceDto,
} from './pricing.dto';
import { dayFromKey, parseDayKey, shiftDayKey, storedDayKey, todayKey } from './day';

/** How many rows one bulk-update transaction touches (≤500/tx). */
export const BULK_CHUNK_SIZE = 500;

/**
 * Automation hook (REQUIREMENTS §52 PRICE_UPDATED trigger). Implemented by
 * the automation module's AutomationService and injected into
 * DailyPriceService AFTER the price mutation commits — the user action never
 * blocks or fails because of automation. Optional so tests/fixtures can omit
 * it.
 */
export interface PriceUpdatedHook {
  handlePriceUpdated(
    companyId: string,
    event: {
      variantId: string;
      variantSku: string;
      categoryId: string | null;
      brandId: string | null;
      uomId: string;
      price: string;
      previousPrice: string | null;
      priceChanged: boolean;
      date: string;
      source: string;
    },
  ): Promise<void>;
}

/** Pure bulk-price arithmetic — exact Prisma.Decimal math, unit-testable. */
export function computeBulkPrice(
  mode: 'PERCENT_UP' | 'PERCENT_DOWN' | 'FIXED_UP' | 'FIXED_DOWN',
  amount: Prisma.Decimal,
  base: Prisma.Decimal,
): Prisma.Decimal {
  switch (mode) {
    case 'PERCENT_UP':
      return base.plus(base.times(amount).dividedBy(100));
    case 'PERCENT_DOWN':
      return base.minus(base.times(amount).dividedBy(100));
    case 'FIXED_UP':
      return base.plus(amount);
    case 'FIXED_DOWN':
      return base.minus(amount);
  }
}

interface BulkRowResult {
  variantId: string;
  dailyPriceId?: string;
  basePrice: string;
  price?: string;
  skipped?: 'NO_UOM' | 'NEGATIVE_PRICE';
}

/**
 * Daily Pricing Engine (Phase 5, REQUIREMENTS §17).
 *
 * One row per (company, variant, date, uom). TODAY upserts are free and
 * audited (PRICE_CHANGED old/new); PAST days are immutable unless the caller
 * holds `pricing.edit_history` (still audited); FUTURE dates are allowed
 * (pre-pricing) and audited. Rows are NEVER deleted — corrections are new
 * versions on the same row plus audit history.
 */
@Injectable()
export class DailyPriceService {
  private readonly logger = new Logger('DailyPriceService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    // Optional DI by token: fires the PRICE_UPDATED automation trigger after
    // commits when the automation module is wired in (omitted in unit tests).
    @Optional() @Inject('PRICE_UPDATED_HOOK')
    private readonly automationHook?: PriceUpdatedHook,
  ) {}

  private async assertVariantInCompany(companyId: string, variantId: string) {
    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, companyId },
      select: {
        id: true,
        sku: true,
        template: { select: { categoryId: true, brandId: true } },
      },
    });
    if (!variant) {
      throw new NotFoundError('Product variant not found', { productVariantId: variantId });
    }
    return variant;
  }

  private async assertUomInCompany(companyId: string, uomId: string): Promise<void> {
    const uom = await this.prisma.uom.findFirst({ where: { id: uomId, companyId }, select: { id: true } });
    if (!uom) throw new NotFoundError('Uom not found', { uomId });
  }

  private async assertSupplierInCompany(companyId: string, partyId: string): Promise<void> {
    const party = await this.prisma.party.findFirst({
      where: { id: partyId, companyId },
      select: { id: true },
    });
    if (!party) throw new NotFoundError('Supplier party not found', { supplierPartyId: partyId });
  }

  /**
   * Create or update the price row for (variant, date, uom). History rule:
   * past dates → ForbiddenError('PRICE_HISTORY_IMMUTABLE') unless
   * `allowHistoryEdit` (pricing.edit_history permission, resolved by the
   * controller from the caller's effective permissions).
   */
  async upsert(
    companyId: string,
    dto: UpsertDailyPriceDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
    opts: { allowHistoryEdit?: boolean } = {},
  ): Promise<DailyPrice> {
    const day = parseDayKey(dto.date);
    // History rule applies to BOTH creates and updates: past days are
    // immutable unless the caller holds pricing.edit_history.
    const isPastDay = storedDayKey(day) < todayKey();
    if (isPastDay && !opts.allowHistoryEdit) {
      throw new ForbiddenError('PRICE_HISTORY_IMMUTABLE', { date: storedDayKey(day) });
    }
    const variant = await this.assertVariantInCompany(companyId, dto.productVariantId);
    await this.assertUomInCompany(companyId, dto.uomId);
    if (dto.supplierPartyId) {
      await this.assertSupplierInCompany(companyId, dto.supplierPartyId);
    }
    const price = roundMoney(D(dto.price));
    if (price.isNegative()) {
      throw new ValidationError('Price must not be negative', { price: dto.price });
    }

    const existing = await this.prisma.dailyPrice.findUnique({
      where: {
        companyId_productVariantId_date_uomId: {
          companyId,
          productVariantId: dto.productVariantId,
          date: day,
          uomId: dto.uomId,
        },
      },
    });

    if (existing) {
      const row = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.dailyPrice.update({
          where: { id: existing.id },
          data: {
            price,
            supplierPartyId: dto.supplierPartyId ?? null,
            notes: dto.notes ?? null,
            source: dto.source ?? existing.source,
            enteredBy: actor.id,
            version: { increment: 1 },
          },
        });
        await this.auditService.recordTx(tx, {
          entityType: 'daily_price',
          entityId: updated.id,
          action: 'PRICE_CHANGED',
          companyId,
          actor,
          oldValues: {
            price: existing.price,
            supplierPartyId: existing.supplierPartyId,
            notes: existing.notes,
            ...(opts.allowHistoryEdit && storedDayKey(existing.date) < todayKey()
              ? { historyEdit: true }
              : {}),
          },
          newValues: {
            price: updated.price,
            supplierPartyId: updated.supplierPartyId,
            notes: updated.notes,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      });
      await this.firePriceUpdated(companyId, row, variant, existing.price);
      return row;
    }

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.dailyPrice.create({
        data: {
          companyId,
          productVariantId: dto.productVariantId,
          date: day,
          uomId: dto.uomId,
          price,
          supplierPartyId: dto.supplierPartyId ?? null,
          source: dto.source ?? 'MANUAL',
          notes: dto.notes ?? null,
          enteredBy: actor.id,
        },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'daily_price',
        entityId: created.id,
        action: 'CREATE',
        companyId,
        actor,
        newValues: {
          productVariantId: created.productVariantId,
          date: storedDayKey(created.date),
          uomId: created.uomId,
          price: created.price,
          supplierPartyId: created.supplierPartyId,
          notes: created.notes,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return created;
    });
    await this.firePriceUpdated(companyId, row, variant, null);
    return row;
  }

  /** Fire-and-log: automation must never break a price write. */
  private async firePriceUpdated(
    companyId: string,
    row: DailyPrice,
    variant: { id: string; sku: string; template: { categoryId: string; brandId: string | null } },
    previousPrice: Prisma.Decimal | null,
  ): Promise<void> {
    if (!this.automationHook) return;
    try {
      await this.automationHook.handlePriceUpdated(companyId, {
        variantId: row.productVariantId,
        variantSku: variant.sku,
        categoryId: variant.template.categoryId,
        brandId: variant.template.brandId,
        uomId: row.uomId,
        price: row.price.toString(),
        previousPrice: previousPrice === null ? null : previousPrice.toString(),
        priceChanged: previousPrice === null || !previousPrice.equals(row.price),
        date: storedDayKey(row.date),
        source: row.source,
      });
    } catch (error) {
      this.logger.error(
        `PRICE_UPDATED automation dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Today's price row for (variant, uom) — null when none. */
  async getToday(
    companyId: string,
    variantId: string,
    uomId?: string,
  ): Promise<DailyPrice | null> {
    const today = todayKey();
    return this.prisma.dailyPrice.findFirst({
      where: {
        companyId,
        productVariantId: variantId,
        ...(uomId ? { uomId } : {}),
        date: { gte: dayFromKey(today), lt: dayFromKey(shiftDayKey(today, 1)) },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  /** Full price history of a variant, newest first (audit via /api/audit). */
  async history(
    companyId: string,
    variantId: string,
    from?: string,
    to?: string,
  ) {
    return this.prisma.dailyPrice.findMany({
      where: {
        companyId,
        productVariantId: variantId,
        ...(from || to
          ? {
              date: {
                ...(from ? { gte: parseDayKey(from) } : {}),
                ...(to ? { lte: parseDayKey(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: [{ date: 'desc' }, { uomId: 'asc' }],
      include: {
        uom: { select: { id: true, symbol: true } },
        supplier: { select: { id: true, nameFa: true } },
      },
    });
  }

  /**
   * Price grid for one day: variant + template/category/brand + TODAY's and
   * YESTERDAY's price (delta display). Exactly 3 queries (variants page +
   * count + the two days' prices), no N+1.
   */
  async grid(
    companyId: string,
    query: {
      date?: string;
      categoryId?: string;
      brandId?: string;
      search?: string;
      page: number;
      pageSize: number;
      skip: number;
      take: number;
    },
  ) {
    const day = query.date ? parseDayKey(query.date) : dayFromKey(todayKey());
    const yesterday = new Date(day.getTime() - 24 * 60 * 60 * 1000);

    const variantWhere: Prisma.ProductVariantWhereInput = {
      companyId,
      ...(query.categoryId || query.brandId
        ? {
            template: {
              ...(query.categoryId ? { categoryId: query.categoryId } : {}),
              ...(query.brandId ? { brandId: query.brandId } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { sku: { contains: query.search, mode: 'insensitive' as const } },
              { nameFa: { contains: query.search } },
              { template: { nameFa: { contains: query.search } } },
            ],
          }
        : {}),
    };

    const [variants, total] = await Promise.all([
      this.prisma.productVariant.findMany({
        where: variantWhere,
        orderBy: { sku: 'asc' },
        skip: query.skip,
        take: query.take,
        select: {
          id: true,
          sku: true,
          nameFa: true,
          active: true,
          defaultUomId: true,
          template: {
            select: {
              id: true,
              nameFa: true,
              category: { select: { id: true, nameFa: true } },
              brand: { select: { id: true, nameFa: true } },
            },
          },
        },
      }),
      this.prisma.productVariant.count({ where: variantWhere }),
    ]);

    const variantIds = variants.map((v) => v.id);
    const prices = variantIds.length
      ? await this.prisma.dailyPrice.findMany({
          where: {
            companyId,
            productVariantId: { in: variantIds },
            date: { gte: yesterday, lte: day },
          },
          orderBy: { date: 'asc' },
        })
      : [];

    const dayKey = storedDayKey(day);
    const yesterdayKey = storedDayKey(yesterday);
    const todayByVariant = new Map<string, DailyPrice>();
    const yesterdayByVariant = new Map<string, DailyPrice>();
    for (const price of prices) {
      const key = storedDayKey(price.date);
      if (key === dayKey) todayByVariant.set(price.productVariantId, price);
      else if (key === yesterdayKey) yesterdayByVariant.set(price.productVariantId, price);
    }

    return {
      date: dayKey,
      items: variants.map((variant) => {
        const todayPrice = todayByVariant.get(variant.id) ?? null;
        const yesterdayPrice = yesterdayByVariant.get(variant.id) ?? null;
        return {
          variantId: variant.id,
          sku: variant.sku,
          nameFa: variant.nameFa,
          defaultUomId: variant.defaultUomId,
          template: variant.template
            ? {
                id: variant.template.id,
                nameFa: variant.template.nameFa,
                categoryId: variant.template.category.id,
                categoryNameFa: variant.template.category.nameFa,
                brandId: variant.template.brand?.id ?? null,
                brandNameFa: variant.template.brand?.nameFa ?? null,
              }
            : null,
          todayPrice: todayPrice
            ? {
                id: todayPrice.id,
                price: todayPrice.price,
                uomId: todayPrice.uomId,
                supplierPartyId: todayPrice.supplierPartyId,
                source: todayPrice.source,
                notes: todayPrice.notes,
                version: todayPrice.version,
                updatedAt: todayPrice.updatedAt,
              }
            : null,
          yesterdayPrice: yesterdayPrice
            ? {
                id: yesterdayPrice.id,
                price: yesterdayPrice.price,
                uomId: yesterdayPrice.uomId,
              }
            : null,
          delta:
            todayPrice && yesterdayPrice
              ? todayPrice.price.minus(yesterdayPrice.price).toString()
              : null,
        };
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Bulk update (REQUIREMENTS §17): percent / fixed amount, up or down,
   * applied to TODAY's rows (create-or-update). Base price = the existing
   * today row, else the template's defaultSalesPrice. Per-row audit + ONE
   * summary audit; runs in ≤500-row chunks per transaction. Rows that would
   * go negative or have no uom are skipped with a reason (never half-written).
   */
  async bulkUpdate(
    companyId: string,
    dto: BulkPriceUpdateDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ) {
    const day = parseDayKey(dto.date);
    if (storedDayKey(day) < todayKey()) {
      throw new ForbiddenError('PRICE_HISTORY_IMMUTABLE', { date: storedDayKey(day) });
    }
    const dayKey = storedDayKey(day);

    // Resolve the target variant set.
    let variantIds: string[];
    if (dto.variantIds && dto.variantIds.length > 0) {
      const rows = await this.prisma.productVariant.findMany({
        where: { id: { in: dto.variantIds }, companyId },
        select: { id: true },
      });
      variantIds = rows.map((r) => r.id);
    } else if (dto.filter && (dto.filter.categoryId || dto.filter.brandId)) {
      const rows = await this.prisma.productVariant.findMany({
        where: {
          companyId,
          active: true,
          template: {
            ...(dto.filter.categoryId ? { categoryId: dto.filter.categoryId } : {}),
            ...(dto.filter.brandId ? { brandId: dto.filter.brandId } : {}),
          },
        },
        select: { id: true },
      });
      variantIds = rows.map((r) => r.id);
    } else {
      throw new ValidationError('variantIds or filter (categoryId/brandId) is required');
    }
    if (variantIds.length === 0) {
      return { date: dayKey, mode: dto.mode, amount: dto.amount, updated: 0, skipped: 0, items: [] };
    }

    const amount = D(dto.amount);
    const results: BulkRowResult[] = [];

    for (let i = 0; i < variantIds.length; i += BULK_CHUNK_SIZE) {
      const chunk = variantIds.slice(i, i + BULK_CHUNK_SIZE);
      await this.prisma.$transaction(async (tx) => {
        const existingRows = await tx.dailyPrice.findMany({
          where: { companyId, productVariantId: { in: chunk }, date: day },
        });
        const existingByVariant = new Map(existingRows.map((r) => [r.productVariantId, r]));
        const variants = await tx.productVariant.findMany({
          where: { id: { in: chunk } },
          select: {
            id: true,
            defaultUomId: true,
            template: { select: { defaultSalesUomId: true, defaultSalesPrice: true } },
          },
        });

        for (const variant of variants) {
          const existing = existingByVariant.get(variant.id);
          const base = existing ? existing.price : variant.template.defaultSalesPrice;
          const uomId = variant.defaultUomId ?? variant.template.defaultSalesUomId;
          if (!uomId) {
            results.push({ variantId: variant.id, basePrice: base.toString(), skipped: 'NO_UOM' });
            continue;
          }
          const nextPrice = roundMoney(computeBulkPrice(dto.mode, amount, D(base)));
          if (nextPrice.isNegative()) {
            results.push({ variantId: variant.id, basePrice: base.toString(), skipped: 'NEGATIVE_PRICE' });
            continue;
          }

          const row = existing
            ? await tx.dailyPrice.update({
                where: { id: existing.id },
                data: {
                  price: nextPrice,
                  enteredBy: actor.id,
                  version: { increment: 1 },
                  ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
                },
              })
            : await tx.dailyPrice.create({
                data: {
                  companyId,
                  productVariantId: variant.id,
                  date: day,
                  uomId,
                  price: nextPrice,
                  source: 'MANUAL',
                  notes: dto.notes ?? null,
                  enteredBy: actor.id,
                },
              });

          await this.auditService.recordTx(tx, {
            entityType: 'daily_price',
            entityId: row.id,
            action: existing ? 'PRICE_CHANGED' : 'CREATE',
            companyId,
            actor,
            oldValues: existing
              ? { price: existing.price, bulk: true }
              : undefined,
            newValues: { price: row.price, bulk: true, mode: dto.mode, amount: dto.amount },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          results.push({
            variantId: variant.id,
            dailyPriceId: row.id,
            basePrice: base.toString(),
            price: row.price.toString(),
          });
        }
      });
    }

    const updated = results.filter((r) => !r.skipped).length;
    const summaryId = randomUUID();
    await this.auditService.record({
      entityType: 'daily_price',
      entityId: summaryId,
      action: 'BULK_PRICE_UPDATE',
      companyId,
      actor,
      newValues: {
        bulkUpdateId: summaryId,
        date: dayKey,
        mode: dto.mode,
        amount: dto.amount,
        updated,
        skipped: results.length - updated,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return {
      date: dayKey,
      mode: dto.mode,
      amount: dto.amount,
      updated,
      skipped: results.length - updated,
      items: results,
    };
  }
}
