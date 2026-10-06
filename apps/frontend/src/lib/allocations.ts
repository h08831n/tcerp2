/**
 * Sales ↔ Purchase line-level allocations (Phase 4, REQUIREMENTS §12).
 * Contract source of truth: apps/backend/src/allocations/* controller + DTOs.
 * Route: /allocations (list REQUIRES one of the document/line filters).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

export function allocationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "ALLOCATION_VARIANT_MISMATCH")
      return "این خط خرید برای همان محصولِ خط فروش نیست.";
    if (message === "ALLOCATION_EXCEEDS_QUANTITY")
      return "تخصیص از مقدار سفارش بیشتر است (خط فروش یا خط خرید).";
    if (message === "ALLOCATION_DUPLICATE")
      return "برای این جفت خط قبلاً تخصیص ثبت شده است.";
    if (message === "ALLOCATION_QUANTITY_POSITIVE")
      return "مقدار تخصیص باید مثبت باشد.";
    if (message === "ALLOCATION_FILTER_REQUIRED")
      return "انتخاب سند فروش یا خرید برای نمایش تخصیص‌ها الزامی است.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// DTOs (exact backend list projection)
// ---------------------------------------------------------------------------

export interface AllocationSide {
  lineId: string;
  documentId: string;
  documentNumber: string;
  orderedQuantity: string;
  variant: { id: string; sku: string; nameFa: string };
}

export interface AllocationDto {
  id: string;
  allocatedQuantity: string;
  createdAt: string;
  sales: AllocationSide;
  purchase: AllocationSide;
}

export interface AllocationQuery {
  page?: number;
  pageSize?: number;
  salesDocumentId?: string;
  purchaseDocumentId?: string;
  salesLineId?: string;
  purchaseLineId?: string;
}

export function fetchAllocations(
  query: AllocationQuery,
): Promise<PaginatedResponse<AllocationDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 100));
  if (query.salesDocumentId) params.set("salesDocumentId", query.salesDocumentId);
  if (query.purchaseDocumentId) params.set("purchaseDocumentId", query.purchaseDocumentId);
  if (query.salesLineId) params.set("salesLineId", query.salesLineId);
  if (query.purchaseLineId) params.set("purchaseLineId", query.purchaseLineId);
  return apiJson<PaginatedResponse<AllocationDto>>(`/allocations?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Mutations — quantity is a JSON number (backend @IsNumber)
// ---------------------------------------------------------------------------

export function createAllocation(body: {
  salesLineId: string;
  purchaseLineId: string;
  allocatedQuantity: number;
  notes?: string;
}): Promise<AllocationDto> {
  return apiJson<AllocationDto>("/allocations", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function updateAllocation(
  id: string,
  allocatedQuantity: number,
): Promise<AllocationDto> {
  return apiJson<AllocationDto>(`/allocations/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ allocatedQuantity }),
  });
}

export function deleteAllocation(id: string): Promise<{ success: boolean }> {
  return apiJson<{ success: boolean }>(`/allocations/${id}`, { method: "DELETE" });
}
