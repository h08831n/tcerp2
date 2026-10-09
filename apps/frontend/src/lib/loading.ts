/**
 * Loadings (bill of lading) API types and helpers (Phase 6, REQUIREMENTS §20).
 * Contract source of truth: apps/backend/src/loading/* controllers + DTOs and
 * apps/backend/src/approvals/* (the debt-gate approval engine).
 *
 * Routes (route base PLURAL /loadings):
 *   GET    /loadings                 — paginated list (loading.view)
 *   POST   /loadings                 — create DRAFT (loading.create)
 *   GET    /loadings/:id             — detail with lines + allocations
 *   DELETE /loadings/:id             — delete DRAFT (loading.cancel)
 *   POST   /loadings/:id/cancel      — DRAFT → CANCELLED
 *   POST   /loadings/:id/confirm     — DRAFT → CONFIRMED (the operational event)
 *   POST   /loadings/:id/driver-info/release|reject — manager debt-gate decision
 *   GET    /loadings/:id/relations   — related documents (document-flow)
 *
 * Money/quantity values ARRIVE AS STRINGS (Prisma Decimal); request bodies
 * send JSON numbers (backend DTOs are @IsNumber).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type LoadingStatus = "DRAFT" | "CONFIRMED" | "CANCELLED";

export const LOADING_STATUSES: LoadingStatus[] = ["DRAFT", "CONFIRMED", "CANCELLED"];

export const LOADING_STATUS_LABELS: Record<LoadingStatus, string> = {
  DRAFT: "پیش‌نویس",
  CONFIRMED: "تأییدشده",
  CANCELLED: "لغوشده",
};

export const LOADING_STATUS_BADGE_CLASSES: Record<LoadingStatus, string> = {
  DRAFT: "border-slate-300 bg-slate-100 text-slate-600",
  CONFIRMED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  CANCELLED: "border-red-200 bg-red-50 text-red-700",
};

/** Stock movement directions (inventory ledger). */
export type StockDirection = "IN" | "OUT";

export const STOCK_DIRECTION_LABELS: Record<StockDirection, string> = {
  IN: "ورود",
  OUT: "خروج",
};

export const STOCK_DIRECTION_BADGE_CLASSES: Record<StockDirection, string> = {
  IN: "border-emerald-200 bg-emerald-50 text-emerald-700",
  OUT: "border-amber-200 bg-amber-50 text-amber-700",
};

/** Approval request statuses (backend ApprovalStatus). */
export type ApprovalStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";

export const APPROVAL_STATUSES: ApprovalStatus[] = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "CANCELLED",
];

export const APPROVAL_STATUS_LABELS: Record<ApprovalStatus, string> = {
  PENDING: "در انتظار تایید",
  APPROVED: "تاییدشده",
  REJECTED: "ردشده",
  CANCELLED: "لغوشده",
};

export const APPROVAL_STATUS_BADGE_CLASSES: Record<ApprovalStatus, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-700",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  REJECTED: "border-red-200 bg-red-50 text-red-700",
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-500",
};

/** Known approval types (Phase 6: the loading debt gate). */
export const APPROVAL_TYPE_LABELS: Record<string, string> = {
  RELEASE_DRIVER_INFO: "افشای اطلاعات راننده",
};

export function approvalTypeLabel(type: string): string {
  return APPROVAL_TYPE_LABELS[type] ?? type;
}

/** Persian translation of well-known backend error tokens. */
export function loadingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "NOT_A_DRIVER") return "شخص انتخاب‌شده نقش راننده ندارد.";
    if (message === "NOT_A_CARRIER") return "شخص انتخاب‌شده نقش حمل‌کننده (باربری) ندارد.";
    if (message === "NOT_A_CUSTOMER") return "شخص انتخاب‌شده نقش مشتری ندارد.";
    if (message === "ALLOCATION_VARIANT_MISMATCH")
      return "خط انتخاب‌شده برای تخصیص، همان محصولِ خط بارگیری نیست.";
    if (message === "ALLOCATION_EXCEEDS_QUANTITY")
      return "مجموع تخصیص‌ها از مقدار سفارش خط بیشتر است.";
    if (message === "ALLOCATION_QUANTITY_POSITIVE")
      return "مقدار تخصیص باید بزرگ‌تر از صفر باشد.";
    if (message === "ALLOCATION_TARGET_REQUIRED")
      return "هر تخصیص باید به یک خط فروش یا خط خرید متصل شود.";
    if (message === "ALLOCATION_SINGLE_TARGET")
      return "هر تخصیص فقط باید یک هدف (خط فروش یا خط خرید) داشته باشد.";
    if (message === "LOADING_LINE_QUANTITY_POSITIVE")
      return "تعداد واقعی هر خط باید بزرگ‌تر از صفر باشد.";
    if (message === "LOADING_LINES_REQUIRED") return "حداقل یک خط بارگیری الزامی است.";
    if (message === "UOM_REQUIRED") return "واحد اندازه‌گیری این محصول یافت نشد.";
    if (message === "UOM_NOT_IN_COMPANY") return "واحد انتخابی در این شرکت تعریف نشده است.";
    if (message === "LOADING_CONFIRMED") return "این بارگیری تأیید شده و تغییر ناپذیر است.";
    if (message === "LOADING_NOT_DRAFT") return "فقط بارگیری پیش‌نویس قابل ویرایش است.";
    if (message === "INVALID_STATUS_TRANSITION")
      return "این تغییر وضعیت مجاز نیست؛ صفحه را بازخوانی کنید.";
    if (message === "VERSION_CONFLICT") return "رکورد تغییر کرده است. آن را بازخوانی کنید.";
    if (message === "LOADING_NOT_RESTRICTED")
      return "این بارگیری محدودیت اطلاعات راننده ندارد.";
    if (message === "NO_PENDING_APPROVAL")
      return "درخواست تایید در انتظاری برای این بارگیری وجود ندارد.";
    if (message === "APPROVAL_ALREADY_DECIDED")
      return "این درخواست قبلاً تصمیم‌گیری شده است.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// DTOs (exact backend shapes)
// ---------------------------------------------------------------------------

export interface LoadingCustomerRef {
  id: string;
  nameFa: string;
}

export interface LoadingPartyDetail {
  id: string;
  nameFa: string;
  nameEn: string | null;
  phones: { kind: string; rawValue: string; normalizedValue: string }[];
}

export interface LoadingWarehouseRef {
  id: string;
  code: string;
  nameFa: string;
}

export interface LoadingAllocationRow {
  id: string;
  loadingLineId: string;
  salesLineId: string | null;
  purchaseLineId: string | null;
  allocatedQuantity: string;
}

export interface LoadingLineRow {
  id: string;
  productVariantId: string;
  actualQuantity: string;
  uomId: string | null;
  notes: string | null;
  allocations: LoadingAllocationRow[];
}

export interface LoadingApprovalRef {
  id: string;
  approvalType: string;
  status: ApprovalStatus;
  createdAt: string;
}

/** GET /loadings/:id — `restricted` marks a stripped payload for this viewer. */
export interface LoadingDetail {
  id: string;
  companyId: string;
  loadingDate: string;
  status: LoadingStatus;
  driverInfoRestricted: boolean;
  warehouseId: string | null;
  customerPartyId: string | null;
  driverPartyId: string | null;
  carrierPartyId: string | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  lines: LoadingLineRow[];
  customer: LoadingCustomerRef | null;
  driver: LoadingPartyDetail | null;
  carrier: LoadingPartyDetail | null;
  warehouse: LoadingWarehouseRef | null;
  approvals: LoadingApprovalRef[];
  restricted: boolean;
}

/** GET /loadings grid projection — lists NEVER carry driver/carrier details. */
export interface LoadingListItem {
  id: string;
  loadingDate: string;
  status: LoadingStatus;
  driverInfoRestricted: boolean;
  warehouse: LoadingWarehouseRef | null;
  customer: LoadingCustomerRef | null;
  lineCount: number;
  totalQuantity: string;
  notes: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export interface LoadingListQuery {
  page?: number;
  pageSize?: number;
  status?: LoadingStatus;
  /** ISO date (YYYY-MM-DD) — inclusive lower bound on loadingDate. */
  from?: string;
  /** ISO date (YYYY-MM-DD) — inclusive upper bound on loadingDate. */
  to?: string;
  customerPartyId?: string;
}

export function fetchLoadings(
  query: LoadingListQuery = {},
): Promise<PaginatedResponse<LoadingListItem>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.status) params.set("status", query.status);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.customerPartyId) params.set("customerPartyId", query.customerPartyId);
  return apiJson<PaginatedResponse<LoadingListItem>>(`/loadings?${params.toString()}`);
}

export function fetchLoading(id: string): Promise<LoadingDetail> {
  return apiJson<LoadingDetail>(`/loadings/${id}`);
}

// ---------------------------------------------------------------------------
// Mutations — quantities are JSON numbers (backend @IsNumber)
// ---------------------------------------------------------------------------

export interface LoadingAllocationInput {
  salesLineId?: string;
  purchaseLineId?: string;
  allocatedQuantity: number;
}

export interface LoadingLineInput {
  productVariantId: string;
  actualQuantity: number;
  uomId?: string;
  notes?: string;
  allocations?: LoadingAllocationInput[];
}

export interface CreateLoadingBody {
  /** ISO date (YYYY-MM-DD). */
  loadingDate: string;
  warehouseId?: string;
  customerPartyId?: string;
  driverPartyId?: string;
  carrierPartyId?: string;
  notes?: string;
  lines: LoadingLineInput[];
}

export function createLoading(body: CreateLoadingBody): Promise<LoadingDetail> {
  return apiJson<LoadingDetail>("/loadings", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function cancelLoading(id: string): Promise<LoadingDetail> {
  return apiJson<LoadingDetail>(`/loadings/${id}/cancel`, { method: "POST" });
}

/** DRAFT → CONFIRMED. The response carries driverInfoRestricted (debt gate). */
export function confirmLoading(id: string): Promise<LoadingDetail> {
  return apiJson<LoadingDetail>(`/loadings/${id}/confirm`, { method: "POST" });
}

/**
 * Manager debt-gate decision on a restricted loading: APPROVED releases the
 * driver/carrier info, REJECTED keeps it hidden.
 */
export function decideDriverInfoRelease(
  id: string,
  decision: "APPROVED" | "REJECTED",
  note?: string,
): Promise<unknown> {
  const path = decision === "APPROVED" ? "release" : "reject";
  return apiJson<unknown>(`/loadings/${id}/driver-info/${path}`, {
    method: "POST",
    body: JSON.stringify(note ? { note } : {}),
  });
}

// ---------------------------------------------------------------------------
// Detail-page enrichment (variant labels + allocation document links)
// ---------------------------------------------------------------------------

export interface VariantLabel {
  nameFa: string;
  sku: string | null;
}

export interface AllocationLineRef {
  kind: "SALES" | "PURCHASE";
  documentId: string;
  documentNumber: string;
  href: string;
}

/**
 * Resolves display data the loading endpoints do not embed: variant names for
 * the line rows and the sales/purchase documents behind allocation targets.
 * Resolution goes through the related documents (loading ↔ sales_document /
 * purchase_document relations, written at confirm) — every fetch is best
 * effort; unresolved ids degrade to their short uuid label.
 */
export async function resolveLoadingReferences(
  loadingId: string,
): Promise<{
  variantLabels: Map<string, VariantLabel>;
  lineRefs: Map<string, AllocationLineRef>;
}> {
  const variantLabels = new Map<string, VariantLabel>();
  const lineRefs = new Map<string, AllocationLineRef>();
  let relations: { relations?: { type?: string; items?: { id?: string }[] }[] } | null = null;
  try {
    relations = await apiJson<{ relations: { type: string; items: { id: string }[] }[] }>(
      `/documents/loading/${loadingId}/relations`,
    );
  } catch {
    return { variantLabels, lineRefs };
  }

  const salesDocIds = new Set<string>();
  const purchaseDocIds = new Set<string>();
  for (const group of relations?.relations ?? []) {
    if (group.type === "sales_document") {
      for (const item of group.items ?? []) if (item.id) salesDocIds.add(item.id);
    } else if (group.type === "purchase_document") {
      for (const item of group.items ?? []) if (item.id) purchaseDocIds.add(item.id);
    }
  }

  await Promise.all([
    ...Array.from(salesDocIds).map(async (docId) => {
      try {
        const sale = await apiJson<{
          documentNumber: string;
          lines: {
            id: string;
            productVariantId: string;
            productVariant: { nameFa: string; sku: string };
          }[];
        }>(`/sales/${docId}`);
        for (const line of sale.lines ?? []) {
          variantLabels.set(line.productVariantId, {
            nameFa: line.productVariant.nameFa,
            sku: line.productVariant.sku,
          });
          lineRefs.set(`S:${line.id}`, {
            kind: "SALES",
            documentId: docId,
            documentNumber: sale.documentNumber,
            href: `/sales/${docId}`,
          });
        }
      } catch {
        /* viewer may lack sales.view — short ids stay */
      }
    }),
    ...Array.from(purchaseDocIds).map(async (docId) => {
      try {
        const purchase = await apiJson<{
          documentNumber: string;
          lines: {
            id: string;
            productVariantId: string;
            productVariant: { nameFa: string; sku: string };
          }[];
        }>(`/purchase/${docId}`);
        for (const line of purchase.lines ?? []) {
          variantLabels.set(line.productVariantId, {
            nameFa: line.productVariant.nameFa,
            sku: line.productVariant.sku,
          });
          lineRefs.set(`P:${line.id}`, {
            kind: "PURCHASE",
            documentId: docId,
            documentNumber: purchase.documentNumber,
            href: `/purchases/${docId}`,
          });
        }
      } catch {
        /* viewer may lack purchase.view — short ids stay */
      }
    }),
  ]);

  return { variantLabels, lineRefs };
}
