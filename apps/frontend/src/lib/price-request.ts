/**
 * Price requests + supplier offers API types and helpers (Phase 4, §14-16).
 * Contract source of truth: apps/backend/src/price-request/* controllers + DTOs.
 * Routes: /price-requests (worklist, daily-lowest, create-sale, create-purchase,
 * lines/:lineId/offers). Money/quantity values ARRIVE AS STRINGS; request
 * bodies send JSON numbers (backend DTOs are @IsNumber).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";
import type { UserRef } from "@/lib/crm";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type PriceRequestStatus = "OPEN" | "OFFERED" | "CONVERTED" | "CLOSED";

export const PRICE_REQUEST_STATUSES: PriceRequestStatus[] = [
  "OPEN",
  "OFFERED",
  "CONVERTED",
  "CLOSED",
];

export const PRICE_REQUEST_STATUS_LABELS: Record<PriceRequestStatus, string> = {
  OPEN: "باز",
  OFFERED: "دارای پیشنهاد",
  CONVERTED: "تبدیل‌شده",
  CLOSED: "بسته",
};

export const PRICE_REQUEST_STATUS_BADGE_CLASSES: Record<PriceRequestStatus, string> = {
  OPEN: "border-amber-200 bg-amber-50 text-amber-700",
  OFFERED: "border-sky-200 bg-sky-50 text-sky-700",
  CONVERTED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  CLOSED: "border-slate-300 bg-slate-100 text-slate-600",
};

export function priceRequestErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "PRICE_REQUEST_CLOSED")
      return "این درخواست بسته/تبدیل شده است و قابل ویرایش نیست.";
    if (message === "PRICE_REQUEST_CONVERTED")
      return "این درخواست تبدیل شده است و پیشنهادهایش قابل تغییر نیستند.";
    if (message === "NOT_A_CUSTOMER") return "شخص انتخاب‌شده نقش مشتری ندارد.";
    if (message === "NOT_A_SUPPLIER") return "شخص انتخاب‌شده نقش تامین‌کننده ندارد.";
    if (message === "CUSTOMER_REQUIRED")
      return "این درخواست مشتری ندارد؛ برای ایجاد فروش ابتدا مشتری را انتخاب کنید.";
    if (message === "NOT_OFFER_OWNER") return "فقط ثبت‌کننده پیشنهاد می‌تواند آن را ویرایش کند.";
    if (message === "UOM_REQUIRED") return "واحد اندازه‌گیری این محصول یافت نشد.";
    if (message === "VERSION_CONFLICT") return "رکورد تغییر کرده است. آن را بازخوانی کنید.";
    if (message === "INVALID_STATUS_TRANSITION")
      return "این تغییر وضعیت مجاز نیست؛ صفحه را بازخوانی کنید.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// DTOs (exact backend shapes)
// ---------------------------------------------------------------------------

export interface SupplierOfferDto {
  id: string;
  priceRequestLineId: string;
  supplierPartyId: string;
  offeredPrice: string;
  uomId: string;
  paymentTerms: string | null;
  deliveryTime: string | null;
  notes: string | null;
  offeredAt: string;
  supplier: { id: string; nameFa: string };
  uom: { id: string; symbol: string };
}

export interface PriceRequestLineDto {
  id: string;
  priceRequestId: string;
  productVariantId: string;
  requestedQuantity: string;
  uomId: string;
  notes: string | null;
  lineOrder: number;
  productVariant: {
    id: string;
    sku: string;
    nameFa: string;
    template: { id: string; nameFa: string };
  };
  uom: { id: string; symbol: string };
  offers?: SupplierOfferDto[];
  /** Today-price hook: null while the Phase 5 daily pricing engine is absent. */
  todayPrice?: string | null;
}

export interface PriceRequestDetail {
  id: string;
  requestNumber: string;
  requesterUserId: string;
  customerPartyId: string | null;
  opportunityId: string | null;
  requestDate: string;
  status: PriceRequestStatus;
  notes: string | null;
  version: number;
  customer: { id: string; nameFa: string } | null;
  requester: UserRef;
  lines: PriceRequestLineDto[];
  /** Conversion-history navigation (Phase 4 correction #2) — offers are never destroyed by convert. */
  salesDocuments?: { id: string; documentNumber: string; status: string; documentDate: string }[];
  purchaseDocuments?: { id: string; documentNumber: string; status: string; documentDate: string }[];
}

/** GET /price-requests worklist projection (no offers/todayPrice). */
export interface WorklistRequestDto {
  id: string;
  requestNumber: string;
  status: PriceRequestStatus;
  requestDate: string;
  notes: string | null;
  customer: { id: string; nameFa: string } | null;
  requester: UserRef;
  lines: {
    id: string;
    productVariantId: string;
    requestedQuantity: string;
    uomId: string;
    lineOrder: number;
    productVariant: {
      id: string;
      sku: string;
      nameFa: string;
      template: { id: string; nameFa: string };
    };
    uom: { id: string; symbol: string };
  }[];
}

export interface WorklistResponse {
  date: string;
  today: WorklistRequestDto[];
  previousDays: WorklistRequestDto[];
}

export interface PriceRequestListItem {
  id: string;
  requestNumber: string;
  status: PriceRequestStatus;
  requestDate: string;
  notes: string | null;
  customer: { id: string; nameFa: string } | null;
  requester: UserRef;
  lineCount: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface PriceRequestQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: PriceRequestStatus;
  customerPartyId?: string;
  requesterUserId?: string;
}

export function fetchPriceRequests(
  query: PriceRequestQuery = {},
): Promise<PaginatedResponse<PriceRequestListItem>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.customerPartyId) params.set("customerPartyId", query.customerPartyId);
  if (query.requesterUserId) params.set("requesterUserId", query.requesterUserId);
  return apiJson<PaginatedResponse<PriceRequestListItem>>(`/price-requests?${params.toString()}`);
}

export function fetchPriceRequestWorklist(date?: string): Promise<WorklistResponse> {
  const params = new URLSearchParams();
  if (date) params.set("date", date);
  return apiJson<WorklistResponse>(`/price-requests/worklist?${params.toString()}`);
}

export function fetchPriceRequest(id: string): Promise<PriceRequestDetail> {
  return apiJson<PriceRequestDetail>(`/price-requests/${id}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface PriceRequestLineInput {
  productVariantId: string;
  requestedQuantity: number;
  uomId?: string;
  notes?: string;
}

export interface CreatePriceRequestBody {
  customerPartyId?: string;
  opportunityId?: string;
  requestDate?: string;
  notes?: string;
  lines?: PriceRequestLineInput[];
}

export function createPriceRequest(body: CreatePriceRequestBody): Promise<PriceRequestDetail> {
  return apiJson<PriceRequestDetail>("/price-requests", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function addPriceRequestLine(
  id: string,
  body: PriceRequestLineInput,
): Promise<PriceRequestDetail> {
  return apiJson<PriceRequestDetail>(`/price-requests/${id}/lines`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deletePriceRequestLine(
  id: string,
  lineId: string,
): Promise<PriceRequestDetail> {
  return apiJson<PriceRequestDetail>(`/price-requests/${id}/lines/${lineId}`, {
    method: "DELETE",
  });
}

export function closePriceRequest(id: string): Promise<PriceRequestDetail> {
  return apiJson<PriceRequestDetail>(`/price-requests/${id}/close`, { method: "POST" });
}

// ── supplier offers ──

export interface AddOfferBody {
  supplierPartyId: string;
  offeredPrice: number;
  uomId?: string;
  paymentTerms?: string;
  deliveryTime?: string;
  notes?: string;
  offeredAt?: string;
}

export function addOffer(lineId: string, body: AddOfferBody): Promise<SupplierOfferDto> {
  return apiJson<SupplierOfferDto>(`/price-requests/lines/${lineId}/offers`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function listOffers(lineId: string): Promise<SupplierOfferDto[]> {
  return apiJson<SupplierOfferDto[]>(`/price-requests/lines/${lineId}/offers`);
}

export function deleteOffer(lineId: string, offerId: string): Promise<{ success: boolean }> {
  return apiJson<{ success: boolean }>(
    `/price-requests/lines/${lineId}/offers/${offerId}`,
    { method: "DELETE" },
  );
}

// ── §16 create sale / purchase from request ──

export interface CreateSaleFromRequestBody {
  customerPartyId?: string;
  salespersonUserId?: string;
  documentDate?: string;
  paymentTermId?: string;
  lineSelections?: { lineId: string; quantity?: number; uomId?: string; unitPrice?: number }[];
}

/**
 * Returns the REQUEST detail (backend contract); the created sale id must be
 * resolved through the document relations (GENERATED_FROM).
 */
export function createSaleFromRequest(
  id: string,
  body: CreateSaleFromRequestBody,
): Promise<PriceRequestDetail> {
  return apiJson<PriceRequestDetail>(`/price-requests/${id}/create-sale`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface CreatePurchaseFromRequestBody {
  supplierPartyId: string;
  buyerUserId?: string;
  documentDate?: string;
  paymentTermId?: string;
  lineSelections?: { lineId: string; quantity?: number; offerId?: string; unitPrice?: number }[];
}

export interface CreatePurchaseFromRequestResponse extends PriceRequestDetail {
  createdPurchaseId: string;
}

export function createPurchaseFromRequest(
  id: string,
  body: CreatePurchaseFromRequestBody,
): Promise<CreatePurchaseFromRequestResponse> {
  return apiJson<CreatePurchaseFromRequestResponse>(`/price-requests/${id}/create-purchase`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
