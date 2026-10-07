import { Injectable } from '@nestjs/common';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../common/errors';
import { PrismaService } from '../prisma/prisma.service';
import { normalizeIranMobile } from '../common/utils/phone';
import { parseDayKey, shiftDayKey, todayKey } from '../pricing/day';

/**
 * Public API (Phase 5, REQUIREMENTS §74-75): unauthenticated, read-only,
 * company-scoped. Auth is a PLACEHOLDER — the optional `X-API-KEY` header is
 * checked against the company-scoped Setting `publicapi.key` when that key
 * is set; full API-key management lands later (see README).
 *
 * Privacy (REQUIREMENTS §75): the portal lookup NEVER leaks customer data —
 * it answers only {matched, linked} for a normalized mobile.
 */
@Injectable()
export class PublicApiService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the company for a public request:
   *   1. X-API-KEY header → the company whose `publicapi.key` Setting equals
   *      it (401 when no company matches);
   *   2. explicit companyId param → the company must exist (placeholder
   *      per-company scoping; callers pass their own company id);
   *   3. otherwise the first company — only while NO company has configured
   *      an API key (once any key exists, key or companyId is required).
   */
  async resolveCompanyId(input: { apiKey?: string; companyId?: string }): Promise<string> {
    if (input.apiKey) {
      const setting = await this.prisma.setting.findFirst({
        where: { key: 'publicapi.key', value: { equals: input.apiKey } },
        select: { companyId: true },
      });
      if (!setting) throw new UnauthorizedError('INVALID_API_KEY');
      return setting.companyId;
    }
    if (input.companyId) {
      const company = await this.prisma.company.findFirst({
        where: { id: input.companyId, status: 'ACTIVE' },
        select: { id: true },
      });
      if (!company) throw new ForbiddenError('Company not found', { companyId: input.companyId });
      return company.id;
    }
    const keyed = await this.prisma.setting.findFirst({
      where: { key: 'publicapi.key' },
      select: { companyId: true },
    });
    if (keyed) {
      throw new UnauthorizedError('API_KEY_REQUIRED');
    }
    const first = await this.prisma.company.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (!first) throw new ForbiddenError('No company exists');
    return first.id;
  }

  private async websiteOnlyVariantIds(companyId: string, day: Date): Promise<string[] | null> {
    const flag = await this.prisma.setting.findFirst({
      where: { companyId, key: 'publicapi.website_only_published' },
      select: { value: true },
    });
    if (flag?.value !== true) return null;
    const items = await this.prisma.publishBatchItem.findMany({
      where: { companyId, channel: 'WEBSITE', status: 'SUCCESS', priceDate: day },
      select: { renderedPayload: true },
    });
    const ids = new Set<string>();
    for (const item of items) {
      const payload = item.renderedPayload as { variantIds?: string[] } | null;
      for (const variantId of payload?.variantIds ?? []) ids.add(variantId);
    }
    return [...ids];
  }

  /** Today's (or a given day's) published prices for the website. */
  async prices(companyId: string, input: { date?: string; companyId?: string }) {
    const dayKey = input.date ?? todayKey();
    const day = parseDayKey(dayKey);

    const variantIdFilter = await this.websiteOnlyVariantIds(companyId, day);
    if (variantIdFilter && variantIdFilter.length === 0) {
      return { date: dayKey, items: [] };
    }

    const rows = await this.prisma.dailyPrice.findMany({
      where: {
        companyId,
        date: day,
        ...(variantIdFilter ? { productVariantId: { in: variantIdFilter } } : {}),
      },
      orderBy: { productVariant: { sku: 'asc' } },
      include: {
        uom: { select: { symbol: true } },
        productVariant: {
          select: {
            id: true,
            sku: true,
            nameFa: true,
            template: {
              select: {
                nameFa: true,
                category: { select: { nameFa: true } },
                brand: { select: { nameFa: true } },
              },
            },
          },
        },
      },
    });

    return {
      date: dayKey,
      items: rows.map((row) => ({
        variantId: row.productVariantId,
        sku: row.productVariant.sku,
        name: row.productVariant.nameFa,
        product: row.productVariant.template.nameFa,
        category: row.productVariant.template.category.nameFa,
        brand: row.productVariant.template.brand?.nameFa ?? null,
        price: row.price,
        uom: row.uom.symbol,
        source: row.source,
        lastUpdatedAt: row.updatedAt,
      })),
    };
  }

  /** Last N days of one variant's price history (newest first). */
  async priceHistory(companyId: string, variantId: string, days = 30) {
    const boundedDays = Math.min(Math.max(days, 1), 365);
    const today = todayKey();
    const from = parseDayKey(shiftDayKey(today, -(boundedDays - 1)));

    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, companyId },
      select: { id: true, sku: true, nameFa: true },
    });
    if (!variant) {
      throw new ForbiddenError('Product variant not found', { variantId });
    }

    const rows = await this.prisma.dailyPrice.findMany({
      where: { companyId, productVariantId: variantId, date: { gte: from, lte: parseDayKey(today) } },
      orderBy: { date: 'desc' },
      include: { uom: { select: { symbol: true } } },
    });

    return {
      variantId: variant.id,
      sku: variant.sku,
      name: variant.nameFa,
      days: boundedDays,
      items: rows.map((row) => ({
        date: row.date.toISOString().slice(0, 10),
        price: row.price,
        uom: row.uom.symbol,
        source: row.source,
      })),
    };
  }

  /**
   * Portal lookup (REQUIREMENTS §75): normalize the mobile, then report ONLY
   * {matched, linked} — never party names, counts exposed to the caller are
   * limited to the boolean signals required for the OTP flow.
   */
  async portalLookup(companyId: string, mobile: string): Promise<{ matched: boolean; linked: boolean }> {
    if (!mobile || typeof mobile !== 'string') {
      throw new ValidationError('mobile query parameter is required');
    }
    const normalized = normalizeIranMobile(mobile);

    const [phoneCount, portalAccount] = await Promise.all([
      this.prisma.partyPhone.count({
        where: { companyId, kind: 'MOBILE', normalizedValue: normalized },
      }),
      this.prisma.portalAccount.findFirst({
        where: { companyId, verifiedMobile: normalized },
        select: { id: true },
      }),
    ]);

    return { matched: phoneCount > 0, linked: !!portalAccount };
  }
}
