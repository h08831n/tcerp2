import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Today's-price hook for Price Request lines (REQUIREMENTS §14):
 * "اگر امروز Product Price موجود بود نشان بده — ولی همچنان کاربر بتواند
 * Price Request ثبت کند" (show today's price when known; the request is
 * registrable regardless).
 *
 * Phase 4 ships the INTERFACE only — the concrete daily-pricing provider
 * (DailyPriceEngine, REQUIREMENTS §17) lands in Phase 5 and is bound to the
 * `TODAY_PRICE_PROVIDER` token. `NullTodayPriceProvider` is the Phase 4
 * default: it always returns null, so requests never depend on pricing data.
 */
export const TODAY_PRICE_PROVIDER = Symbol('TODAY_PRICE_PROVIDER');

export interface TodayPrice {
  price: Prisma.Decimal | string | number;
  /** Where the price came from, e.g. `daily_price`, `manual_publish`. */
  source: string;
}

export interface TodayPriceProvider {
  /**
   * Today's price for (variant, uom) — null when the company has no price
   * data yet. Implementations MUST be tolerant: a pricing outage must never
   * block a price request.
   */
  getTodayPrice(
    companyId: string,
    variantId: string,
    uomId: string,
    date?: Date,
  ): Promise<TodayPrice | null>;
}

/** Phase 4 default: pricing engine not yet wired (Phase 5). */
@Injectable()
export class NullTodayPriceProvider implements TodayPriceProvider {
  async getTodayPrice(): Promise<TodayPrice | null> {
    return null;
  }
}
