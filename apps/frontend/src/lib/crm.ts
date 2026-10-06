/**
 * CRM funnel API types and helpers (Phase 4).
 * Contract source of truth: apps/backend/src/crm/* controllers + DTOs.
 * Routes: /leads, /opportunities, /lost-reasons, /payment-terms.
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type LeadStatus = "NEW" | "CONTACTED" | "QUALIFIED" | "LOST";

export const LEAD_STATUSES: LeadStatus[] = ["NEW", "CONTACTED", "QUALIFIED", "LOST"];

export const LEAD_STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: "جدید",
  CONTACTED: "تماس گرفته‌شده",
  QUALIFIED: "واجد شرایط",
  LOST: "باخته",
};

/** Backend-enforced transitions: NEW → CONTACTED → QUALIFIED|LOST. */
export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  NEW: ["CONTACTED"],
  CONTACTED: ["QUALIFIED", "LOST"],
  QUALIFIED: [],
  LOST: [],
};

export type OpportunityStatus = "OPEN" | "QUALIFIED" | "QUOTED" | "WON" | "LOST";

export const OPPORTUNITY_STATUSES: OpportunityStatus[] = [
  "OPEN",
  "QUALIFIED",
  "QUOTED",
  "WON",
  "LOST",
];

export const OPPORTUNITY_STATUS_LABELS: Record<OpportunityStatus, string> = {
  OPEN: "باز",
  QUALIFIED: "واجد شرایط",
  QUOTED: "پیش‌فاکتورشده",
  WON: "موفق",
  LOST: "باخته",
};

/** Backend-enforced transitions: OPEN → QUALIFIED → QUOTED → WON|LOST. */
export const OPPORTUNITY_TRANSITIONS: Record<OpportunityStatus, OpportunityStatus[]> = {
  OPEN: ["QUALIFIED", "LOST"],
  QUALIFIED: ["QUOTED", "LOST"],
  QUOTED: ["WON", "LOST"],
  WON: [],
  LOST: [],
};

export function crmErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "NOT_A_CUSTOMER") return "شخص انتخاب‌شده نقش مشتری ندارد.";
    if (message === "LOST_REASON_REQUIRED") return "برای باخت، انتخاب دلیل الزامی است.";
    if (message === "VERSION_CONFLICT")
      return "رکورد توسط کاربر دیگری تغییر کرده است. لطفاً صفحه را بازخوانی کنید.";
    if (message === "SALESPERSON_NOT_COMPANY_MEMBER")
      return "فروشنده انتخاب‌شده عضو فعال شرکت نیست.";
    if (message === "INVALID_LEAD_STATUS_TRANSITION")
      return "این تغییر وضعیت سرنخ مجاز نیست (زنجیره: جدید ← تماس ← واجد شرایط/باخته).";
    if (message === "INVALID_OPPORTUNITY_STATUS_TRANSITION")
      return "این تغییر وضعیت فرصت مجاز نیست.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// Shared envelopes
// ---------------------------------------------------------------------------

export interface UserRef {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
}

export function userDisplayName(
  user: { username: string; firstName?: string | null; lastName?: string | null } | null | undefined,
): string {
  if (!user) return "—";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.username || "—";
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export interface LeadDto {
  id: string;
  partyId: string | null;
  name: string;
  phone: string | null;
  source: string | null;
  campaign: string | null;
  media: string | null;
  referrer: string | null;
  assignedSalespersonId: string | null;
  status: LeadStatus;
  notes: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  party: { id: string; nameFa: string } | null;
  salesperson: { id: string; username: string } | null;
}

export interface LeadQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: LeadStatus;
  partyId?: string;
  assignedSalespersonId?: string;
}

export function fetchLeads(query: LeadQuery = {}): Promise<PaginatedResponse<LeadDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.partyId) params.set("partyId", query.partyId);
  if (query.assignedSalespersonId) params.set("assignedSalespersonId", query.assignedSalespersonId);
  return apiJson<PaginatedResponse<LeadDto>>(`/leads?${params.toString()}`);
}

export function fetchLead(id: string): Promise<LeadDto> {
  return apiJson<LeadDto>(`/leads/${id}`);
}

export interface CreateLeadBody {
  name: string;
  partyId?: string;
  phone?: string;
  source?: string;
  campaign?: string;
  media?: string;
  referrer?: string;
  assignedSalespersonId?: string;
  notes?: string;
}

export function createLead(body: CreateLeadBody): Promise<LeadDto> {
  return apiJson<LeadDto>("/leads", { method: "POST", body: JSON.stringify(body) });
}

export interface UpdateLeadBody extends Omit<Partial<CreateLeadBody>, "partyId" | "assignedSalespersonId"> {
  status?: LeadStatus;
  partyId?: string | null;
  assignedSalespersonId?: string | null;
  version: number;
}

export function updateLead(id: string, body: UpdateLeadBody): Promise<LeadDto> {
  return apiJson<LeadDto>(`/leads/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteLead(id: string): Promise<{ success: boolean }> {
  return apiJson<{ success: boolean }>(`/leads/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export interface OpportunityDto {
  id: string;
  customerPartyId: string;
  salespersonUserId: string;
  title: string;
  description: string | null;
  /** Decimal — arrives as string. */
  estimatedAmount: string | null;
  /** Decimal — arrives as string. */
  estimatedTonnage: string | null;
  status: OpportunityStatus;
  source: string | null;
  lostReasonId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  customer: { id: string; nameFa: string };
  salesperson: UserRef;
  lostReason?: { id: string; nameFa: string; code: string } | null;
}

export interface OpportunityQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: OpportunityStatus;
  customerPartyId?: string;
  salespersonUserId?: string;
}

export function fetchOpportunities(
  query: OpportunityQuery = {},
): Promise<PaginatedResponse<OpportunityDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.search) params.set("search", query.search);
  if (query.status) params.set("status", query.status);
  if (query.customerPartyId) params.set("customerPartyId", query.customerPartyId);
  if (query.salespersonUserId) params.set("salespersonUserId", query.salespersonUserId);
  return apiJson<PaginatedResponse<OpportunityDto>>(`/opportunities?${params.toString()}`);
}

export function fetchOpportunity(id: string): Promise<OpportunityDto> {
  return apiJson<OpportunityDto>(`/opportunities/${id}`);
}

export interface CreateOpportunityBody {
  customerPartyId: string;
  salespersonUserId: string;
  title: string;
  description?: string;
  estimatedAmount?: number;
  estimatedTonnage?: number;
  source?: string;
}

export function createOpportunity(body: CreateOpportunityBody): Promise<OpportunityDto> {
  return apiJson<OpportunityDto>("/opportunities", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateOpportunityBody extends Partial<CreateOpportunityBody> {
  status?: OpportunityStatus;
  lostReasonId?: string;
  version: number;
}

export function updateOpportunity(id: string, body: UpdateOpportunityBody): Promise<OpportunityDto> {
  return apiJson<OpportunityDto>(`/opportunities/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Lost reasons (configurable; required for LOST transitions)
// ---------------------------------------------------------------------------

export interface LostReasonDto {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
}

export async function fetchLostReasons(active = true): Promise<LostReasonDto[]> {
  const params = new URLSearchParams();
  params.set("page", "1");
  params.set("pageSize", "100");
  if (active !== undefined) params.set("active", String(active));
  const data = await apiJson<PaginatedResponse<LostReasonDto>>(`/lost-reasons?${params.toString()}`);
  return [...data.items].sort((a, b) => a.sortOrder - b.sortOrder);
}

// ---------------------------------------------------------------------------
// Payment terms
// ---------------------------------------------------------------------------

export interface PaymentTermDto {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  description: string | null;
  daysOffset: number | null;
  active: boolean;
  createdAt: string;
}

export async function fetchPaymentTerms(active = true): Promise<PaymentTermDto[]> {
  const params = new URLSearchParams();
  params.set("page", "1");
  params.set("pageSize", "100");
  if (active !== undefined) params.set("active", String(active));
  const data = await apiJson<PaginatedResponse<PaymentTermDto>>(`/payment-terms?${params.toString()}`);
  return data.items;
}
