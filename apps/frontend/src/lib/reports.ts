import { apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ───────────────────────── types ─────────────────────────

export interface DebtReportItem {
  partyId: string;
  nameFa: string;
  accountingBalance: number;
  operationalBalance: number | null;
  reconciliationDelta: number | null;
  unmatchedClaims: { count: number; total: number };
  unsettledChecks: { count: number; total: number; nearestDueDate: string | null };
  lastActivity: string | null;
}

export interface DebtReport {
  role: "CUSTOMER" | "SUPPLIER";
  accountCode: string;
  groupTotal: number;
  items: DebtReportItem[];
}

export interface OffersOutcomeReport {
  perSupplier: Array<{
    partyId: string;
    supplierName: string;
    offersCount: number;
    won: number;
    lost: number;
    winRate: number;
    avgOfferedPrice: number | null;
  }>;
  recent: Array<{
    offerId: string;
    supplierName: string;
    offeredPrice: number;
    outcome: "WON" | "LOST" | null;
    decidedAt: string | null;
    requestId: string;
    requestNumber: string;
  }>;
}

export interface WarehouseNegativeStockItem {
  warehouseId: string | null;
  warehouseName: string | null;
  variantId: string;
  sku: string;
  variantName: string;
  balance: number;
}

export interface WarehouseTurnoverItem {
  warehouseId: string | null;
  warehouseName: string | null;
  variantId: string;
  sku: string;
  variantName: string;
  inQty: number;
  outQty: number;
  endingBalance: number;
}

// ───────────────────────── clients ─────────────────────────

export function fetchDebtReport(
  role: "CUSTOMER" | "SUPPLIER",
  search?: string,
): Promise<DebtReport> {
  const params = new URLSearchParams({ role });
  if (search?.trim()) params.set("search", search.trim());
  return apiJson<DebtReport>(`/reports/debt?${params.toString()}`);
}

export function fetchOffersOutcome(): Promise<OffersOutcomeReport> {
  return apiJson<OffersOutcomeReport>("/reports/offers-outcome");
}

export function fetchWarehouseNegative(): Promise<WarehouseNegativeStockItem[]> {
  return apiJson<WarehouseNegativeStockItem[]>("/reports/negative-stock/by-warehouse");
}

export function fetchWarehouseTurnover(
  from?: string,
  to?: string,
): Promise<WarehouseTurnoverItem[]> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  return apiJson<WarehouseTurnoverItem[]>(`/reports/warehouse-turnover?${params.toString()}`);
}

export function decideOfferOutcome(
  offerId: string,
  outcome: "WON" | "LOST",
): Promise<unknown> {
  return apiJson(`/price-requests/offers/${offerId}/outcome`, {
    method: "POST",
    body: JSON.stringify({ outcome }),
  });
}

// ─────────────────── saved views (localStorage) ───────────────────

export interface SavedView {
  name: string;
  filters: Record<string, string>;
  savedAt: string;
}

const VIEWS_KEY = "tcerp:saved-views";

export function loadSavedViews(scope: string): SavedView[] {
  if (typeof window === "undefined") return [];
  try {
    const all = JSON.parse(window.localStorage.getItem(VIEWS_KEY) ?? "{}") as Record<
      string,
      SavedView[]
    >;
    return all[scope] ?? [];
  } catch {
    return [];
  }
}

export function saveView(scope: string, name: string, filters: Record<string, string>): void {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(VIEWS_KEY) ?? "{}") as Record<
      string,
      SavedView[]
    >;
    const list = (all[scope] ?? []).filter((v) => v.name !== name);
    list.push({ name, filters, savedAt: new Date().toISOString() });
    all[scope] = list.slice(-10); // at most 10 views per scope
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable (private mode) — views are a convenience, never critical
  }
}

export function deleteSavedView(scope: string, name: string): void {
  if (typeof window === "undefined") return;
  try {
    const all = JSON.parse(window.localStorage.getItem(VIEWS_KEY) ?? "{}") as Record<
      string,
      SavedView[]
    >;
    all[scope] = (all[scope] ?? []).filter((v) => v.name !== name);
    window.localStorage.setItem(VIEWS_KEY, JSON.stringify(all));
  } catch {
    // ignore
  }
}
