/**
 * Purchase documents API types and helpers (Phase 4, REQUIREMENTS §11).
 * Contract source of truth: apps/backend/src/purchase/* controllers + DTOs.
 * Route base is SINGULAR: /purchase. Company-wide visibility (no record
 * scope). Money/quantity values ARRIVE AS STRINGS; request bodies send
 * JSON numbers (backend DTOs are @IsNumber).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type PurchaseStatus =
  | "DRAFT"
  | "ORDER_PLACED"
  | "PARTIALLY_LOADED"
  | "COMPLETED"
  | "CANCELLED";

export const PURCHASE_STATUSES: PurchaseStatus[] = [
  "DRAFT",
  "ORDER_PLACED",
  "PARTIALLY_LOADED",
  "COMPLETED",
  "CANCELLED",
];

export const PURCHASE_STATUS_LABELS: Record<PurchaseStatus, string> = {
  DRAFT: "پیش‌نویس",
  ORDER_PLACED: "سفارش ثبت‌شده",
  PARTIALLY_LOADED: "بارگیری جزئی",
  COMPLETED: "تکمیل",
  CANCELLED: "لغو",
};

export const PURCHASE_STATUS_BADGE_CLASSES: Record<PurchaseStatus, string> = {
  DRAFT: "border-slate-300 bg-slate-100 text-slate-600",
  ORDER_PLACED: "border-sky-200 bg-sky-50 text-sky-700",
  PARTIALLY_LOADED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  CANCELLED: "border-red-200 bg-red-50 text-red-700",
};

export function purchaseErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "DOCUMENT_CLOSED") return "این سند بسته شده است و امکان ویرایش ندارد.";
    if (message === "NOT_A_SUPPLIER") return "شخص انتخاب‌شده نقش تامین‌کننده ندارد.";
    if (message === "NOT_A_CUSTOMER") return "شخص انتخاب‌شده نقش مشتری ندارد.";
    if (message === "BUYER_NOT_COMPANY_MEMBER") return "خریدار انتخاب‌شده عضو فعال شرکت نیست.";
    if (message === "VERSION_CONFLICT") return "رکورد تغییر کرده است. آن را بازخوانی کنید.";
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

export interface PurchaseTotals {
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
}

/** GET /api/purchase grid projection. */
export interface PurchaseDocumentListItem {
  id: string;
  documentNumber: string;
  status: PurchaseStatus;
  documentDate: string;
  supplier: { id: string; nameFa: string };
  buyer: { id: string; name: string };
  totals: PurchaseTotals;
  lineCount: number;
  version: number;
}

export interface PurchaseVariantRef {
  id: string;
  sku: string;
  nameFa: string;
  template: { id: string; nameFa: string };
}

/** GET /api/purchase/:id — lines included, money as strings. */
export interface PurchaseLineDto {
  id: string;
  productVariantId: string;
  orderedQuantity: string;
  uomId: string;
  unitPrice: string;
  lineTotal: string;
  notes: string | null;
  lineOrder: number;
  productVariant: PurchaseVariantRef;
  uom: { id: string; symbol: string; nameFa: string };
}

export interface PurchaseDocumentDetail {
  id: string;
  documentNumber: string;
  status: PurchaseStatus;
  documentDate: string;
  currency: string;
  supplier: { id: string; nameFa: string };
  buyer: { id: string; username: string; firstName: string | null; lastName: string | null };
  paymentTerm: { id: string; code: string; nameFa: string } | null;
  priceRequest: { id: string; requestNumber: string } | null;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  version: number;
  lines: PurchaseLineDto[];
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface PurchaseListQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: PurchaseStatus;
  supplierPartyId?: string;
  buyerUserId?: string;
  dateFrom?: string;
  dateTo?: string;
  sortDir?: "asc" | "desc";
}

export function fetchPurchases(
  query: PurchaseListQuery = {},
): Promise<PaginatedResponse<PurchaseDocumentListItem>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.supplierPartyId) params.set("supplierPartyId", query.supplierPartyId);
  if (query.buyerUserId) params.set("buyerUserId", query.buyerUserId);
  if (query.dateFrom) params.set("dateFrom", query.dateFrom);
  if (query.dateTo) params.set("dateTo", query.dateTo);
  if (query.sortDir) params.set("sortDir", query.sortDir);
  return apiJson<PaginatedResponse<PurchaseDocumentListItem>>(`/purchase?${params.toString()}`);
}

export function fetchPurchase(id: string): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface PurchaseLineInput {
  productVariantId: string;
  quantity: number;
  uomId?: string;
  unitPrice?: number;
  notes?: string;
}

export interface CreatePurchaseBody {
  supplierPartyId: string;
  buyerUserId?: string;
  documentDate?: string;
  currency?: string;
  paymentTermId?: string;
  priceRequestId?: string;
  lines?: PurchaseLineInput[];
}

export function createPurchase(body: CreatePurchaseBody): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>("/purchase", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdatePurchaseBody {
  documentDate?: string;
  paymentTermId?: string | null;
  notes?: string;
  version: number;
}

export function updatePurchase(
  id: string,
  body: UpdatePurchaseBody,
): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ── lines ──

export function addPurchaseLine(
  id: string,
  body: PurchaseLineInput,
): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}/lines`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updatePurchaseLine(
  id: string,
  lineId: string,
  body: {
    productVariantId?: string;
    quantity?: number;
    uomId?: string;
    unitPrice?: number;
    notes?: string;
  },
): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}/lines/${lineId}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deletePurchaseLine(
  id: string,
  lineId: string,
): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}/lines/${lineId}`, {
    method: "DELETE",
  });
}

// ── transitions ──

export function placePurchase(id: string): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}/place`, { method: "POST" });
}

export function completePurchase(id: string): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}/complete`, { method: "POST" });
}

export function cancelPurchase(id: string): Promise<PurchaseDocumentDetail> {
  return apiJson<PurchaseDocumentDetail>(`/purchase/${id}/cancel`, { method: "POST" });
}

// ── cross-flow: purchase → sale (sales module owns the endpoint) ──

export function createSaleFromPurchase(
  purchaseId: string,
  body: {
    customerPartyId: string;
    salespersonUserId?: string;
    documentDate?: string;
    paymentTermId?: string;
  },
): Promise<import("@/lib/sales").SalesDocumentDetail> {
  return apiJson(`/purchase/${purchaseId}/create-sale`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
