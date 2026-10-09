/**
 * Inventory API types and helpers (Phase 6, REQUIREMENTS §21).
 * Contract source of truth: apps/backend/src/inventory/* controllers + DTOs.
 *
 * Routes (route base SINGULAR /inventory):
 *   GET  /inventory/stock                  — computed per-variant stock
 *   GET  /inventory/movements              — movement ledger
 *   GET  /inventory/warehouses             — warehouse list
 *   POST /inventory/warehouses             — create (inventory.warehouses.manage)
 *   PATCH/DELETE /inventory/warehouses/:id — update / delete
 *   POST /inventory/warehouses/:id/set-default — flip the company default
 *
 * Stock/movement quantities ARRIVE AS STRINGS (Prisma Decimal). No manual
 * stock entry exists — movements come only from confirmed loadings (OUT) and
 * purchase receiving (IN).
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";
import type { StockDirection } from "@/lib/loading";

// ---------------------------------------------------------------------------
// Error tokens → Persian
// ---------------------------------------------------------------------------

export function inventoryErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "WAREHOUSE_CODE_EXISTS") return "کد انبار تکراری است.";
    if (message === "WAREHOUSE_DEFAULT_EXISTS")
      return "قبلاً انبار پیش‌فرض تعریف شده است؛ ابتدا پیش‌فرض فعلی را تغییر دهید.";
    if (message === "WAREHOUSE_IN_USE")
      return "این انبار دارای گردش کالاست و قابل حذف نیست.";
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

export interface StockVariantRef {
  id: string;
  sku: string;
  nameFa: string;
  nameEn: string | null;
  templateNameFa: string;
  categoryNameFa: string | null;
  brandNameFa: string | null;
  uomSymbol: string | null;
}

/** GET /inventory/stock row — computed SUM(IN) − SUM(OUT) per variant. */
export interface StockRow {
  variant: StockVariantRef;
  stock: string;
  negative: boolean;
}

export interface StockQuery {
  page?: number;
  pageSize?: number;
  warehouseId?: string;
  variantId?: string;
  categoryId?: string;
  search?: string;
}

export function fetchStock(query: StockQuery = {}): Promise<PaginatedResponse<StockRow>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.warehouseId) params.set("warehouseId", query.warehouseId);
  if (query.variantId) params.set("variantId", query.variantId);
  if (query.categoryId) params.set("categoryId", query.categoryId);
  if (query.search) params.set("search", query.search);
  return apiJson<PaginatedResponse<StockRow>>(`/inventory/stock?${params.toString()}`);
}

export interface StockMovementRow {
  id: string;
  companyId: string;
  warehouseId: string;
  productVariantId: string;
  direction: StockDirection;
  quantity: string;
  uomId: string;
  movementDate: string;
  sourceEntityType: "PURCHASE" | "LOADING";
  sourceEntityId: string;
  idempotencyKey: string;
  createdAt: string;
  warehouse: { id: string; code: string; nameFa: string };
  productVariant: { id: string; sku: string; nameFa: string };
  uom: { id: string; symbol: string };
}

export interface MovementQuery {
  page?: number;
  pageSize?: number;
  warehouseId?: string;
  variantId?: string;
  sourceEntityType?: "PURCHASE" | "LOADING";
  sourceEntityId?: string;
  from?: string;
  to?: string;
}

export function fetchMovements(
  query: MovementQuery = {},
): Promise<PaginatedResponse<StockMovementRow>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.warehouseId) params.set("warehouseId", query.warehouseId);
  if (query.variantId) params.set("variantId", query.variantId);
  if (query.sourceEntityType) params.set("sourceEntityType", query.sourceEntityType);
  if (query.sourceEntityId) params.set("sourceEntityId", query.sourceEntityId);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return apiJson<PaginatedResponse<StockMovementRow>>(`/inventory/movements?${params.toString()}`);
}

export interface WarehouseDto {
  id: string;
  companyId: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  isDefault: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchWarehouses(active?: boolean): Promise<WarehouseDto[]> {
  const suffix = active === undefined ? "" : `?active=${String(active)}`;
  return apiJson<WarehouseDto[]>(`/inventory/warehouses${suffix}`);
}

export interface CreateWarehouseBody {
  code: string;
  nameFa: string;
  nameEn?: string;
  isDefault?: boolean;
}

export function createWarehouse(body: CreateWarehouseBody): Promise<WarehouseDto> {
  return apiJson<WarehouseDto>("/inventory/warehouses", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateWarehouseBody {
  code?: string;
  nameFa?: string;
  nameEn?: string | null;
  isDefault?: boolean;
  active?: boolean;
}

export function updateWarehouse(id: string, body: UpdateWarehouseBody): Promise<WarehouseDto> {
  return apiJson<WarehouseDto>(`/inventory/warehouses/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function setDefaultWarehouse(id: string): Promise<WarehouseDto> {
  return apiJson<WarehouseDto>(`/inventory/warehouses/${id}/set-default`, { method: "POST" });
}

export function deleteWarehouse(id: string): Promise<{ deleted: boolean }> {
  return apiJson<{ deleted: boolean }>(`/inventory/warehouses/${id}`, { method: "DELETE" });
}
