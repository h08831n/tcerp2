/**
 * Daily Pricing Engine API types and helpers (Phase 5, REQUIREMENTS §17).
 * Contract source of truth: apps/backend/src/pricing/* controllers + DTOs +
 * daily-price.service.ts. Money/decimal values ARRIVE AS STRINGS (Prisma
 * Decimal); request bodies send JSON numbers (backend DTOs are @IsNumber).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type DailyPriceSource = "MANUAL" | "SUPPLIER_OFFER" | "IMPORTED" | "API";

export const DAILY_PRICE_SOURCES: DailyPriceSource[] = [
  "MANUAL",
  "SUPPLIER_OFFER",
  "IMPORTED",
  "API",
];

export const DAILY_PRICE_SOURCE_LABELS: Record<DailyPriceSource, string> = {
  MANUAL: "دستی",
  SUPPLIER_OFFER: "پیشنهاد تامین‌کننده",
  IMPORTED: "وارد شده",
  API: "رابط برنامه‌ای",
};

/** Modes for the bulk price update (backend BulkPriceUpdateDto.mode). */
export type BulkPriceMode = "PERCENT_UP" | "PERCENT_DOWN" | "FIXED_UP" | "FIXED_DOWN";

export const BULK_PRICE_MODES: BulkPriceMode[] = [
  "PERCENT_UP",
  "PERCENT_DOWN",
  "FIXED_UP",
  "FIXED_DOWN",
];

export const BULK_PRICE_MODE_LABELS: Record<BulkPriceMode, string> = {
  PERCENT_UP: "درصد افزایش",
  PERCENT_DOWN: "درصد کاهش",
  FIXED_UP: "مبلغ افزایش (ریال)",
  FIXED_DOWN: "مبلغ کاهش (ریال)",
};

/** Persian translation of well-known backend error tokens. */
export function pricingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "PRICE_HISTORY_IMMUTABLE")
      return "قیمت روزهای گذشته قابل تغییر نیست.";
    if (message === "VERSION_CONFLICT" || (message && message.includes("VERSION_CONFLICT")))
      return "رکورد توسط کاربر دیگری تغییر کرده است. لطفاً صفحه را بازخوانی کنید.";
    if (message.includes("Price must not be negative"))
      return "قیمت نباید منفی باشد.";
    if (message.includes("Product variant not found"))
      return "محصول (variant) یافت نشد.";
    if (message.includes("Uom not found")) return "واحد اندازه‌گیری یافت نشد.";
    if (message.includes("Supplier party not found"))
      return "تامین‌کننده انتخاب‌شده یافت نشد.";
    if (message.includes("variantIds or filter"))
      return "برای اعمال گروهی، انتخاب ردیف‌ها یا فیلتر گروه/برند الزامی است.";
    if (message.includes("No daily price for this variant"))
      return "برای این محصول در تاریخ انتخابی قیمتی ثبت نشده است.";
    if (message.includes("not found")) return "رکورد مورد نظر یافت نشد.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

/** Persian reason for a skipped bulk row (daily-price BulkRowResult.skipped). */
export function bulkSkipReason(skip: string): string {
  if (skip === "NO_UOM") return "واحد اندازه‌گیری ندارد";
  if (skip === "NEGATIVE_PRICE") return "قیمت نهایی منفی می‌شود";
  return skip;
}

// ---------------------------------------------------------------------------
// Grid (GET /pricing/daily)
// ---------------------------------------------------------------------------

export interface DailyPriceSnapshot {
  id: string;
  price: string;
  uomId: string;
  supplierPartyId: string | null;
  source: DailyPriceSource;
  notes: string | null;
  version: number;
  updatedAt: string;
}

export interface DailyGridTemplate {
  id: string;
  nameFa: string;
  categoryId: string;
  categoryNameFa: string;
  brandId: string | null;
  brandNameFa: string | null;
}

export interface DailyPriceGridRow {
  variantId: string;
  sku: string;
  nameFa: string;
  defaultUomId: string | null;
  template: DailyGridTemplate | null;
  todayPrice: DailyPriceSnapshot | null;
  yesterdayPrice: { id: string; price: string; uomId: string } | null;
  delta: string | null;
}

export interface DailyPriceGridResponse {
  date: string;
  items: DailyPriceGridRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DailyGridQuery {
  date?: string;
  categoryId?: string;
  brandId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function fetchDailyGrid(query: DailyGridQuery = {}): Promise<DailyPriceGridResponse> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.date) params.set("date", query.date);
  if (query.categoryId) params.set("categoryId", query.categoryId);
  if (query.brandId) params.set("brandId", query.brandId);
  if (query.search) params.set("search", query.search);
  return apiJson<DailyPriceGridResponse>(`/pricing/daily?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Upsert (POST /pricing/daily) + today
// ---------------------------------------------------------------------------

export interface UpsertDailyPriceBody {
  productVariantId: string;
  /** YYYY-MM-DD — today upserts are free, past days need pricing.edit_history. */
  date: string;
  uomId: string;
  price: number;
  supplierPartyId?: string;
  source?: DailyPriceSource;
  notes?: string;
}

export interface DailyPriceDto {
  id: string;
  companyId: string;
  productVariantId: string;
  date: string;
  price: string;
  uomId: string;
  supplierPartyId: string | null;
  source: DailyPriceSource;
  notes: string | null;
  enteredBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function upsertDailyPrice(body: UpsertDailyPriceBody): Promise<DailyPriceDto> {
  return apiJson<DailyPriceDto>("/pricing/daily", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function fetchTodayPrice(
  variantId: string,
  uomId?: string,
): Promise<DailyPriceDto | null> {
  const params = new URLSearchParams({ variantId });
  if (uomId) params.set("uomId", uomId);
  return apiJson<DailyPriceDto | null>(`/pricing/daily/today?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// History (GET /pricing/daily/history)
// ---------------------------------------------------------------------------

export interface DailyPriceHistoryRow extends DailyPriceDto {
  uom: { id: string; symbol: string };
  supplier: { id: string; nameFa: string } | null;
}

export function fetchDailyHistory(
  variantId: string,
  from?: string,
  to?: string,
): Promise<DailyPriceHistoryRow[]> {
  const params = new URLSearchParams({ variantId });
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return apiJson<DailyPriceHistoryRow[]>(`/pricing/daily/history?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Bulk update (POST /pricing/daily/bulk)
// ---------------------------------------------------------------------------

export interface BulkPriceUpdateBody {
  /** YYYY-MM-DD — bulk updates apply to TODAY's rows (create-or-update). */
  date: string;
  variantIds?: string[];
  filter?: { categoryId?: string; brandId?: string };
  mode: BulkPriceMode;
  amount: number;
  notes?: string;
}

export interface BulkPriceResultItem {
  variantId: string;
  dailyPriceId?: string;
  basePrice: string;
  price?: string;
  skipped?: "NO_UOM" | "NEGATIVE_PRICE";
}

export interface BulkPriceUpdateResult {
  date: string;
  mode: BulkPriceMode;
  amount: number;
  updated: number;
  skipped: number;
  items: BulkPriceResultItem[];
}

export function bulkUpdatePrices(body: BulkPriceUpdateBody): Promise<BulkPriceUpdateResult> {
  return apiJson<BulkPriceUpdateResult>("/pricing/daily/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Cheapest supplier report (GET /pricing/suppliers/cheapest)
// ---------------------------------------------------------------------------

export interface CheapestSupplierQuery {
  variantId: string;
  days?: number;
  uomId?: string;
}

export interface CheapestSupplierItem {
  supplierPartyId: string;
  supplierNameFa: string;
  uomId: string;
  uomSymbol: string;
  winCount: number;
  /** ISO timestamp of the most recent day this supplier was the daily cheapest. */
  lastWonAt: string | null;
}

export interface CheapestSupplierReport {
  variantId: string;
  days: number;
  uomId?: string;
  items: CheapestSupplierItem[];
}

export function fetchCheapestSuppliers(
  query: CheapestSupplierQuery,
): Promise<CheapestSupplierReport> {
  const params = new URLSearchParams({ variantId: query.variantId });
  if (query.days) params.set("days", String(query.days));
  if (query.uomId) params.set("uomId", query.uomId);
  return apiJson<CheapestSupplierReport>(`/pricing/suppliers/cheapest?${params.toString()}`);
}
