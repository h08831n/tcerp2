/**
 * Sales documents API types and helpers (Phase 4, REQUIREMENTS §9-10).
 * Contract source of truth: apps/backend/src/sales/* controllers + DTOs.
 * ONE entity for quotation → sales order: same id, same number, only the
 * status changes. Money/quantity values ARRIVE AS STRINGS (Prisma Decimal);
 * request bodies send JSON numbers (backend DTOs are @IsNumber).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type SalesDocumentStatus =
  | "DRAFT"
  | "QUOTATION"
  | "SENT"
  | "CUSTOMER_CONFIRMED"
  | "SALES_ORDER"
  | "PARTIALLY_LOADED"
  | "COMPLETED"
  | "CANCELLED"
  | "LOST";

export const SALES_STATUSES: SalesDocumentStatus[] = [
  "DRAFT",
  "QUOTATION",
  "SENT",
  "CUSTOMER_CONFIRMED",
  "SALES_ORDER",
  "PARTIALLY_LOADED",
  "COMPLETED",
  "CANCELLED",
  "LOST",
];

export const SALES_STATUS_LABELS: Record<SalesDocumentStatus, string> = {
  DRAFT: "پیش‌نویس",
  QUOTATION: "پیش‌فاکتور",
  SENT: "ارسال‌شده",
  CUSTOMER_CONFIRMED: "تأیید مشتری",
  SALES_ORDER: "سفارش فروش",
  PARTIALLY_LOADED: "بارگیری جزئی",
  COMPLETED: "تکمیل",
  CANCELLED: "لغو",
  LOST: "از دست رفته",
};

export const SALES_STATUS_BADGE_CLASSES: Record<SalesDocumentStatus, string> = {
  DRAFT: "border-slate-300 bg-slate-100 text-slate-600",
  QUOTATION: "border-sky-200 bg-sky-50 text-sky-700",
  SENT: "border-indigo-200 bg-indigo-50 text-indigo-700",
  CUSTOMER_CONFIRMED: "border-amber-200 bg-amber-50 text-amber-700",
  SALES_ORDER: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARTIALLY_LOADED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  COMPLETED: "border-emerald-300 bg-emerald-100 text-emerald-800",
  CANCELLED: "border-red-200 bg-red-50 text-red-700",
  LOST: "border-rose-200 bg-rose-50 text-rose-700",
};

/** After these statuses the committed line fields are locked (p4-10). */
export const SALES_LOCKED_STATUSES: SalesDocumentStatus[] = [
  "CUSTOMER_CONFIRMED",
  "SALES_ORDER",
  "PARTIALLY_LOADED",
  "COMPLETED",
];

export function isSalesLocked(status: SalesDocumentStatus): boolean {
  return SALES_LOCKED_STATUSES.includes(status);
}

/** Persian translation of well-known backend error tokens. */
export function salesErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "ORDER_LOCKED") return "سفارش تأییدشده برای شما قفل است.";
    if (message === "OVERRIDE_REASON_REQUIRED") return "دلیل اصلاح الزامی است.";
    if (message === "LOST_REASON_REQUIRED") return "انتخاب دلیل باخت الزامی است.";
    if (message === "VERSION_CONFLICT") return "رکورد تغییر کرده است. آن را بازخوانی کنید.";
    if (message === "NOT_A_CUSTOMER") return "شخص انتخاب‌شده نقش مشتری ندارد.";
    if (message === "NOT_A_SUPPLIER") return "شخص انتخاب‌شده نقش تامین‌کننده ندارد.";
    if (message === "SALESPERSON_NOT_COMPANY_MEMBER")
      return "فروشنده انتخاب‌شده عضو فعال شرکت نیست.";
    if (message === "BUYER_NOT_COMPANY_MEMBER") return "خریدار انتخاب‌شده عضو فعال شرکت نیست.";
    if (message === "MATRIX_EMPTY")
      return "هیچ سلول پرشده‌ای وجود ندارد؛ حداقل برای یک سلول تعداد وارد کنید.";
    if (message === "UOM_REQUIRED") return "واحد اندازه‌گیری این محصول یافت نشد.";
    if (message === "INVALID_STATUS_TRANSITION")
      return "این تغییر وضعیت مجاز نیست؛ صفحه را بازخوانی کنید.";
    if (message === "NOTHING_TO_UPDATE") return "تغییری برای ذخیره وجود ندارد.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// DTOs (exact backend shapes)
// ---------------------------------------------------------------------------

export interface SalesPartyRef {
  id: string;
  nameFa: string;
}

export interface SalesPersonRef {
  id: string;
  name: string;
}

export interface SalesTotals {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

/** GET /api/sales grid projection. */
export interface SalesDocumentListItem {
  id: string;
  documentNumber: string;
  status: SalesDocumentStatus;
  documentDate: string;
  expirationDate: string;
  customer: SalesPartyRef;
  salesperson: SalesPersonRef;
  totals: SalesTotals;
  lineCount: number;
  version: number;
}

export interface SalesVariantRef {
  id: string;
  sku: string;
  nameFa: string;
  template: { id: string; nameFa: string };
}

export interface SalesUomRef {
  id: string;
  symbol: string;
  nameFa: string;
}

export interface SalesTaxDefinitionRef {
  id: string;
  code: string;
  name: string;
  rate: string;
}

/** GET /api/sales/:id — lines included, money as strings. */
export interface SalesLineDto {
  id: string;
  productVariantId: string;
  printableDescription: string | null;
  orderedQuantity: string;
  uomId: string;
  unitPrice: string;
  /** p5c price provenance: MANUAL | DAILY_PRICE | TEMPLATE_DEFAULT. */
  priceSource: string | null;
  /** ISO date of the snapshotted DailyPrice day (DAILY_PRICE lines only). */
  priceDate: string | null;
  discountAmount: string;
  taxDefinitionId: string | null;
  taxRateSnapshot: string | null;
  subtotal: string;
  taxAmount: string;
  lineTotal: string;
  notes: string | null;
  lineOrder: number;
  productVariant: SalesVariantRef;
  uom: SalesUomRef;
  taxDefinition: SalesTaxDefinitionRef | null;
}

export interface SalesDocumentDetail {
  id: string;
  documentNumber: string;
  status: SalesDocumentStatus;
  documentDate: string;
  expirationDate: string;
  currency: string;
  customer: SalesPartyRef;
  salesperson: { id: string; username: string; firstName: string | null; lastName: string | null };
  paymentTerm: { id: string; code: string; nameFa: string } | null;
  lostReason: { id: string; code: string; nameFa: string } | null;
  priceRequest: { id: string; requestNumber: string } | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  /** Phase 6: Σ(allocatedQuantity × line.unitPrice) of confirmed loading allocations. */
  operationalLoadedAmount?: string | null;
  version: number;
  lines: SalesLineDto[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface SalesListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: SalesDocumentStatus;
  customerPartyId?: string;
  salespersonUserId?: string;
  opportunityId?: string;
  expired?: boolean;
  dateFrom?: string;
  dateTo?: string;
  sortDir?: "asc" | "desc";
}

export function fetchSales(query: SalesListQuery = {}): Promise<PaginatedResponse<SalesDocumentListItem>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.customerPartyId) params.set("customerPartyId", query.customerPartyId);
  if (query.salespersonUserId) params.set("salespersonUserId", query.salespersonUserId);
  if (query.opportunityId) params.set("opportunityId", query.opportunityId);
  if (query.expired !== undefined) params.set("expired", String(query.expired));
  if (query.dateFrom) params.set("dateFrom", query.dateFrom);
  if (query.dateTo) params.set("dateTo", query.dateTo);
  if (query.sortDir) params.set("sortDir", query.sortDir);
  return apiJson<PaginatedResponse<SalesDocumentListItem>>(`/sales?${params.toString()}`);
}

export function fetchSale(id: string): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/** Line input for create/add — numbers on the wire (backend @IsNumber). */
export interface SalesLineInput {
  productVariantId: string;
  quantity: number;
  uomId?: string;
  unitPrice?: number;
  discountAmount?: number;
  taxDefinitionId?: string;
  printableDescription?: string;
  notes?: string;
}

export interface CreateSalesBody {
  customerPartyId: string;
  salespersonUserId?: string;
  opportunityId?: string;
  documentDate?: string;
  expirationDate?: string;
  currency?: string;
  paymentTermId?: string;
  shippingAddressId?: string;
  language?: string;
  quotationTemplateCode?: string;
  priceRequestId?: string;
  status?: "DRAFT" | "QUOTATION";
  lines?: SalesLineInput[];
}

export function createSale(body: CreateSalesBody): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>("/sales", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateSalesBody {
  documentDate?: string;
  expirationDate?: string;
  paymentTermId?: string | null;
  shippingAddressId?: string | null;
  language?: string;
  quotationTemplateCode?: string;
  notes?: string;
  version: number;
}

export function updateSale(id: string, body: UpdateSalesBody): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ── transitions (same id, same number) ──

export function sendSale(id: string): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/send`, { method: "POST" });
}

export function confirmSale(id: string): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/confirm`, { method: "POST" });
}

export function activateSale(id: string): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/activate`, { method: "POST" });
}

export function loseSale(
  id: string,
  body: { lostReasonId: string; notes?: string },
): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/lost`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelSale(id: string): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/cancel`, { method: "POST" });
}

// ── lines ──

export function addSaleLine(
  id: string,
  body: SalesLineInput & { overrideReason?: string },
): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/lines`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface MatrixCellInput {
  productVariantId: string;
  quantity?: number;
  uomId?: string;
  unitPrice?: number;
  discountAmount?: number;
  taxDefinitionId?: string;
  printableDescription?: string;
  notes?: string;
}

/** POST /api/sales/:id/lines/matrix — ONE line per NON-EMPTY cell. */
export function addSaleLinesFromMatrix(
  id: string,
  cells: MatrixCellInput[],
  reason?: string,
): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/lines/matrix`, {
    method: "POST",
    body: JSON.stringify({ cells, ...(reason ? { reason } : {}) }),
  });
}

export interface UpdateSalesLineBody {
  productVariantId?: string;
  quantity?: number;
  uomId?: string;
  unitPrice?: number;
  discountAmount?: number;
  taxDefinitionId?: string | null;
  printableDescription?: string;
  notes?: string;
  overrideReason?: string;
}

export function updateSaleLine(
  id: string,
  lineId: string,
  body: UpdateSalesLineBody,
): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteSaleLine(
  id: string,
  lineId: string,
  overrideReason?: string,
): Promise<SalesDocumentDetail> {
  return apiJson<SalesDocumentDetail>(`/sales/${id}/lines/${lineId}`, {
    method: "DELETE",
    ...(overrideReason ? { body: JSON.stringify({ overrideReason }) } : {}),
  });
}

// ── cross-flow: sale → purchase (purchase module owns the endpoint) ──

export function createPurchaseFromSale(
  saleId: string,
  body: {
    supplierPartyId: string;
    buyerUserId?: string;
    documentDate?: string;
    paymentTermId?: string;
  },
): Promise<import("@/lib/purchase").PurchaseDocumentDetail> {
  return apiJson(`/sales/${saleId}/create-purchase`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
