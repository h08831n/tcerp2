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
 *
 * p5c pricing-integrity review — visibility levels. The company Setting
 * `publicapi.visibility` selects what the price endpoints expose:
 *   - `ALL`            (default) every ACTIVE variant's day prices;
 *   - `PUBLISHED_ONLY` only variants covered by a SUCCESS WEBSITE
 *                      PublishBatchItem for that day;
 *   - `PORTAL_ONLY`    /api/public/prices* answer 403 PORTAL_REQUIRED —
 *                      customers use the portal; /api/public/portal/lookup
 *                      stays open (it exposes nothing).
 * The legacy Setting `publicapi.website_only_published=true` is honored as
 * an alias for PUBLISHED_ONLY. In ALL and PUBLISHED_ONLY modes a variant
 * with `isPublic=false` (ProductVariant, toggled via PATCH
 * /api/products/templates/:id/variants/:variantId, products.edit) is
 * excluded from every public endpoint.
 */
/** The three visibility levels (Setting `publicapi.visibility`). */
export type PublicVisibility = 'ALL' | 'PUBLISHED_ONLY' | 'PORTAL_ONLY';

export const PUBLIC_VISIBILITY_SETTING = 'publicapi.visibility';
export const LEGACY_WEBSITE_ONLY_SETTING = 'publicapi.website_only_published';
const VISIBILITY_VALUES: PublicVisibility[] = ['ALL', 'PUBLISHED_ONLY', 'PORTAL_ONLY'];

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

  /**
   * Resolve the visibility level for a company (see class doc): the Setting
   * `publicapi.visibility` wins; the legacy `publicapi.website_only_published=true`
   * aliases to PUBLISHED_ONLY; anything else defaults to ALL.
   */
  async resolveVisibility(companyId: string): Promise<PublicVisibility> {
    const setting = await this.prisma.setting.findFirst({
      where: { companyId, key: PUBLIC_VISIBILITY_SETTING },
      select: { value: true },
    });
    const raw = setting?.value;
    if (typeof raw === 'string' && (VISIBILITY_VALUES as string[]).includes(raw)) {
      return raw as PublicVisibility;
    }
    const legacy = await this.prisma.setting.findFirst({
      where: { companyId, key: LEGACY_WEBSITE_ONLY_SETTING },
      select: { value: true },
    });
    if (legacy?.value === true) return 'PUBLISHED_ONLY';
    return 'ALL';
  }

  /** Variant ids covered by a SUCCESS WEBSITE publish item for `day`. */
  private async publishedVariantIds(companyId: string, day: Date): Promise<string[]> {
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

    const visibility = await this.resolveVisibility(companyId);
    if (visibility === 'PORTAL_ONLY') {
      // Portal-only companies expose NO open price API; the portal lookup
      // endpoint stays up (it leaks nothing — see portalLookup).
      throw new ForbiddenError('PORTAL_REQUIRED');
    }
    const publishedIds =
      visibility === 'PUBLISHED_ONLY' ? await this.publishedVariantIds(companyId, day) : null;
    if (publishedIds && publishedIds.length === 0) {
      return { date: dayKey, items: [] };
    }

    const rows = await this.prisma.dailyPrice.findMany({
      where: {
        companyId,
        date: day,
        ...(publishedIds ? { productVariantId: { in: publishedIds } } : {}),
        // isPublic=false variants are hidden from the open price API in every
        // mode that serves prices (p5c review); inactive variants too.
        productVariant: { isPublic: true, active: true },
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
    // PORTAL_ONLY companies answer 403 on ALL /api/public/prices* routes.
    if ((await this.resolveVisibility(companyId)) === 'PORTAL_ONLY') {
      throw new ForbiddenError('PORTAL_REQUIRED');
    }
    const boundedDays = Math.min(Math.max(days, 1), 365);
    const today = todayKey();
    const from = parseDayKey(shiftDayKey(today, -(boundedDays - 1)));

    const variant = await this.prisma.productVariant.findFirst({
      where: { id: variantId, companyId },
      select: { id: true, sku: true, nameFa: true, isPublic: true },
    });
    // Unknown AND isPublic=false variants are indistinguishable (p5c: hidden
    // variants must not be enumerable through the public API).
    if (!variant || !variant.isPublic) {
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
