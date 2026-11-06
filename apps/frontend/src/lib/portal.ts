"use client";

/**
 * Customer portal API client (D-2 Phase 3 UI).
 * The portal is COOKIE-authenticated (portal_session / portal_pending,
 * HttpOnly) — every request goes out with credentials: "include" and never
 * touches the employee JWT flow. 401 = no/expired session → back to login.
 */

export const PORTAL_API_BASE =
  process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api";

export class PortalApiError extends Error {
  code: string;
  status: number;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "PortalApiError";
    this.status = status;
    this.code = code;
  }
}

async function parseError(response: Response): Promise<PortalApiError> {
  try {
    const data = await response.json();
    const message =
      typeof data?.message === "string" && data.message
        ? data.message
        : "خطای پورتال";
    return new PortalApiError(message, response.status, data?.code ?? "PORTAL_ERROR");
  } catch {
    return new PortalApiError("خطای پورتال", response.status, "PORTAL_ERROR");
  }
}

async function portalFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${PORTAL_API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as T;
}

// ---------------------------------------------------------------- auth flow

export async function requestOtp(mobile: string): Promise<{ challengeId: string; sent: boolean }> {
  return portalFetch("/portal/request-otp", {
    method: "POST",
    body: JSON.stringify({ mobile }),
  });
}

export async function verifyOtp(
  mobile: string,
  challengeId: string,
  code: string,
): Promise<{ sessionActive: boolean; pendingSelection?: Array<{ portalAccountId: string; companyName: string }> }> {
  return portalFetch("/portal/verify-otp", {
    method: "POST",
    body: JSON.stringify({ mobile, challengeId, code }),
  });
}

export async function selectCompany(portalAccountId: string): Promise<{ sessionActive: boolean }> {
  return portalFetch("/portal/select-company", {
    method: "POST",
    body: JSON.stringify({ portalAccountId }),
  });
}

export async function portalLogout(): Promise<void> {
  await portalFetch("/portal/logout", { method: "POST" });
}

// ---------------------------------------------------------------- read models

export interface PortalMe {
  companyId: string;
  partyId: string;
}

export interface PortalProfile {
  partyId: string;
  partyName: string;
  partyNameEn?: string | null;
  internalCode?: string | null;
  companyName: string;
  roles: string[];
}

export interface PortalOrderLine {
  productSku: string;
  productName: string;
  orderedQuantity: number;
  uom: string;
  unitPrice: number;
}

export interface PortalOrder {
  id: string;
  documentNumber: string;
  documentDate: string;
  status: string;
  currency: string;
  total: number;
  subtotal?: number;
  notes?: string | null;
  lines: PortalOrderLine[];
}

export interface PortalOrderList {
  items: PortalOrder[];
  page: number;
  limit: number;
  total: number;
}

export interface PortalLoadingLine {
  productSku: string;
  productName: string;
  actualQuantity: number;
  uom: string;
}

export interface PortalLoading {
  id: string;
  loadingDate: string;
  status: string;
  route?: string | null;
  lines: PortalLoadingLine[];
}

export interface PortalLoadingList {
  items: PortalLoading[];
  page: number;
  limit: number;
  total: number;
}

export interface PortalDebt {
  balance: number;
  direction: "DEBT" | "CREDIT";
  currency: string;
  lastComputedAt: string | null;
}

export interface PortalFile {
  id: string;
  entityType: string;
  entityId: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: string;
}

export const portalApi = {
  me: () => portalFetch<PortalMe>("/portal/me"),
  profile: () => portalFetch<PortalProfile>("/portal/profile"),
  orders: (page = 1, status?: string) =>
    portalFetch<PortalOrderList>(`/portal/orders?page=${page}${status ? `&status=${status}` : ""}`),
  order: (id: string) => portalFetch<PortalOrder>(`/portal/orders/${id}`),
  loadings: (page = 1) => portalFetch<PortalLoadingList>(`/portal/loadings?page=${page}`),
  loading: (id: string) => portalFetch<PortalLoading>(`/portal/loadings/${id}`),
  debt: () => portalFetch<PortalDebt>("/portal/debt"),
  files: () => portalFetch<{ items: PortalFile[]; total: number }>("/portal/files"),
};

/** Direct download link — the cookie rides along with credentials. */
export function portalFileDownloadUrl(attachmentId: string): string {
  return `${PORTAL_API_BASE}/portal/files/${attachmentId}/download`;
}
