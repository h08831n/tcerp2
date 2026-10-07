import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TodayPrice, TodayPriceProvider } from '../price-request/today-price.provider';
import { dayFromKey, shiftDayKey, todayKey } from './day';

/**
 * Phase 5 concrete implementation of the Phase 4 TODAY_PRICE_PROVIDER hook
 * (REQUIREMENTS §14 + §17): price-request lines now show the real daily
 * price. Tolerant by contract — any failure resolves to null so a pricing
 * outage can never block a price request.
 */
@Injectable()
export class DailyPriceTodayPriceProvider implements TodayPriceProvider {
  constructor(private readonly prisma: PrismaService) {}

  async getTodayPrice(
    companyId: string,
    variantId: string,
    uomId: string,
    date: Date = new Date(),
  ): Promise<TodayPrice | null> {
    try {
      const key =
        date instanceof Date
          ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
          : todayKey();
      const row = await this.prisma.dailyPrice.findFirst({
        where: {
          companyId,
          productVariantId: variantId,
          uomId,
          date: {
            gte: dayFromKey(key),
            lt: dayFromKey(shiftDayKey(key, 1)),
          },
        },
        orderBy: { updatedAt: 'desc' },
        select: { price: true, source: true },
      });
      return row ? { price: row.price, source: 'daily_price' } : null;
    } catch {
      return null;
    }
  }
}
