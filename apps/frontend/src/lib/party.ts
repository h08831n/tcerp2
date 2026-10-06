/** Party/CRM API types and display helpers (Phase 3A frozen contract). */

import { ApiError, apiJson } from "@/lib/api";

export type PartyType = "COMPANY" | "PERSON";

export type PartyRole = "CUSTOMER" | "SUPPLIER" | "DRIVER" | "CARRIER" | "PARTNER";

export const PARTY_ROLES: PartyRole[] = [
  "CUSTOMER",
  "SUPPLIER",
  "DRIVER",
  "CARRIER",
  "PARTNER",
];

export type PhoneKind = "MOBILE" | "PHONE" | "FAX" | "WHATSAPP";

export const PHONE_KINDS: PhoneKind[] = ["MOBILE", "PHONE", "FAX", "WHATSAPP"];

export const PARTY_TYPE_LABELS: Record<PartyType, string> = {
  COMPANY: "شرکت",
  PERSON: "شخص",
};

export const PARTY_ROLE_LABELS: Record<PartyRole, string> = {
  CUSTOMER: "مشتری",
  SUPPLIER: "تامین‌کننده",
  DRIVER: "راننده",
  CARRIER: "حمل‌کننده",
  PARTNER: "شریک",
};

export const PHONE_KIND_LABELS: Record<PhoneKind, string> = {
  MOBILE: "موبایل",
  PHONE: "تلفن",
  FAX: "فکس",
  WHATSAPP: "واتس‌اپ",
};

export const ADDRESS_TYPE_LABELS: Record<string, string> = {
  MAIN: "اصلی",
  BILLING: "صورتحساب",
  SHIPPING: "ارسال",
  WAREHOUSE: "انبار",
  OTHER: "سایر",
};

export const SCORE_LEVEL_LABELS: Record<string, string> = {
  A: "طلایی",
  B: "نقره‌ای",
  C: "برنزی",
  D: "معمولی",
  GOLD: "طلایی",
  SILVER: "نقره‌ای",
  BRONZE: "برنزی",
  REGULAR: "معمولی",
  PLATINUM: "پلاتینیوم",
};

export function scoreLevelLabel(level: string | null | undefined): string {
  if (!level) return "—";
  return SCORE_LEVEL_LABELS[level] ?? level;
}

/** Persian translation of well-known backend error codes. */
export function partyErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.message === "DUPLICATE_PHONE") return "شماره موبایل تکراری است.";
    if (error.message === "VERSION_CONFLICT")
      return "رکورد توسط کاربر دیگری تغییر کرده است. لطفاً صفحه را بازخوانی کنید.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface PartyOwner {
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string;
}

/** corr-02: owner summary on the party grid (display name, no extra fields). */
export interface PartyGridOwner {
  id: string;
  name: string;
}

/** corr-02: primary phone summary on the party grid. */
export interface PartyGridPhone {
  kind: PhoneKind;
  normalizedValue: string;
}

/** corr-02: exact backend grid projection for GET /api/parties. */
export interface PartyListItem {
  id: string;
  type: PartyType;
  nameFa: string;
  nameEn?: string | null;
  internalCode?: string | null;
  primaryPhone: PartyGridPhone | null;
  roles: PartyRole[];
  owner: PartyGridOwner | null;
  score: number | null;
  scoreLevel: string | null;
  archived: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PartyPhoneDto {
  id?: string;
  kind: PhoneKind;
  value?: string;
  rawValue?: string;
  normalizedValue?: string;
  isPrimary?: boolean;
}

export interface PartyContactDto {
  id: string;
  name: string;
  position?: string | null;
  email?: string | null;
  isPrimary?: boolean;
  phones: PartyPhoneDto[];
}

export interface PartyAddressDto {
  id: string;
  type: string;
  province?: string | null;
  city?: string | null;
  postalCode?: string | null;
  line: string;
  isPrimary?: boolean;
}

export interface PartyDetail {
  id: string;
  type: PartyType;
  nameFa: string;
  nameEn?: string | null;
  internalCode?: string | null;
  nationalId?: string | null;
  economicCode?: string | null;
  registrationNumber?: string | null;
  nationalCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  birthDate?: string | null;
  website?: string | null;
  email?: string | null;
  notes?: string | null;
  owner: PartyOwner | null;
  version: number;
  archivedAt: string | null;
  score: number | null;
  scoreLevel: string | null;
  createdAt?: string;
  roles: { role: PartyRole; since: string }[];
  phones: PartyPhoneDto[];
  contacts: PartyContactDto[];
  addresses: PartyAddressDto[];
}

export interface DuplicateExact {
  partyId: string;
  nameFa: string;
  mobile?: string | null;
}

export interface DuplicateSimilar {
  partyId: string;
  nameFa: string;
  similarity: number;
}

export interface CheckDuplicateResponse {
  exact?: DuplicateExact;
  similar: DuplicateSimilar[];
}

export interface CreatePartyResponse {
  party: PartyDetail;
  warnings?: { type: string; partyId: string; nameFa: string; similarity: number }[];
}

export interface PartyListResponse {
  items: PartyListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface TimelineItemDto {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  actorType?: string | null;
  createdAt: string;
}

export interface FinancialMemberDto {
  partyId: string;
  nameFa: string;
  score: number | null;
  balance: number | null;
}

export interface FinancialResponsibilityResponse {
  group: { responsiblePartyId: string; name: string } | null;
  members: FinancialMemberDto[];
  consolidated: number | null;
}

export interface ScoreHistoryEntry {
  score: number;
  level: string;
  metrics: Record<string, number>;
  computedAt: string;
}

export interface ScoreResponse {
  score: number;
  level: string;
  metrics: Record<string, number>;
  history: ScoreHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

export interface PartyListQuery {
  page: number;
  pageSize: number;
  search?: string;
  type?: PartyType | "";
  role?: PartyRole | "";
  archived?: boolean;
  sort?: "nameFa" | "createdAt" | "score";
  dir?: "asc" | "desc";
}

export function fetchParties(query: PartyListQuery): Promise<PartyListResponse> {
  const params = new URLSearchParams();
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  if (query.search) params.set("search", query.search);
  if (query.type) params.set("type", query.type);
  if (query.role) params.set("role", query.role);
  if (query.archived !== undefined) params.set("archived", String(query.archived));
  if (query.sort) params.set("sort", query.sort);
  if (query.dir) params.set("dir", query.dir);
  return apiJson<PartyListResponse>(`/parties?${params.toString()}`);
}

export function fetchParty(id: string): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}`);
}

export function checkDuplicate(body: {
  mobile?: string;
  nameFa?: string;
}): Promise<CheckDuplicateResponse> {
  return apiJson<CheckDuplicateResponse>("/parties/check-duplicate", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface CreatePartyBody {
  type: PartyType;
  nameFa: string;
  nameEn?: string;
  internalCode?: string;
  nationalId?: string;
  economicCode?: string;
  registrationNumber?: string;
  nationalCode?: string;
  firstName?: string;
  lastName?: string;
  birthDate?: string;
  website?: string;
  email?: string;
  notes?: string;
  ownerUserId?: string;
  roles: PartyRole[];
  phones: { kind: PhoneKind; value: string; isPrimary?: boolean }[];
}

export function createParty(body: CreatePartyBody): Promise<CreatePartyResponse> {
  return apiJson<CreatePartyResponse>("/parties", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UserOption {
  id: string;
  firstName: string | null;
  lastName: string | null;
  username: string;
}

/** Fetches /users?search= tolerating both {items:[...]} and bare arrays. */
export async function fetchUsers(search: string): Promise<UserOption[]> {
  const data = await apiJson<unknown>(
    `/users?search=${encodeURIComponent(search)}`,
  );
  const items = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown[] })?.items)
      ? ((data as { items: unknown[] }).items)
      : [];
  return items as UserOption[];
}

export function ownerDisplayName(owner: PartyOwner | null | undefined): string {
  if (!owner) return "—";
  const name = [owner.firstName, owner.lastName].filter(Boolean).join(" ").trim();
  return name || owner.username || "—";
}

// ---------------------------------------------------------------------------
// Detail-page mutations
// ---------------------------------------------------------------------------

export function updateParty(
  id: string,
  body: Partial<CreatePartyBody> & { version: number },
): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function archiveParty(id: string): Promise<void> {
  return apiJson<void>(`/parties/${id}`, { method: "DELETE" });
}

export function restoreParty(id: string): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/restore`, { method: "POST" });
}

export function setPartyOwner(id: string, userId: string): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/owner`, {
    method: "POST",
    body: JSON.stringify({ userId }),
  });
}

export function addPartyRole(id: string, role: PartyRole): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/roles`, {
    method: "POST",
    body: JSON.stringify({ role }),
  });
}

export function removePartyRole(id: string, role: PartyRole): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/roles/${role}`, { method: "DELETE" });
}

export function addPartyPhone(
  id: string,
  body: { kind: PhoneKind; value: string; isPrimary?: boolean },
): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/phones`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deletePartyPhone(id: string, phoneId: string): Promise<void> {
  return apiJson<void>(`/parties/${id}/phones/${phoneId}`, { method: "DELETE" });
}

export function addPartyContact(
  id: string,
  body: {
    name: string;
    position?: string;
    email?: string;
    isPrimary?: boolean;
    phones?: { kind: PhoneKind; value: string; isPrimary?: boolean }[];
  },
): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/contacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deletePartyContact(id: string, contactId: string): Promise<void> {
  return apiJson<void>(`/parties/${id}/contacts/${contactId}`, { method: "DELETE" });
}

export function addPartyAddress(
  id: string,
  body: {
    type: string;
    province?: string;
    city?: string;
    postalCode?: string;
    line: string;
    isPrimary?: boolean;
  },
): Promise<PartyDetail> {
  return apiJson<PartyDetail>(`/parties/${id}/addresses`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function deletePartyAddress(id: string, addressId: string): Promise<void> {
  return apiJson<void>(`/parties/${id}/addresses/${addressId}`, { method: "DELETE" });
}

export function fetchTimeline(id: string, limit = 50): Promise<{ items: TimelineItemDto[] }> {
  return apiJson<{ items: TimelineItemDto[] }>(`/parties/${id}/timeline?limit=${limit}`);
}

export function fetchFinancialResponsibility(
  id: string,
): Promise<FinancialResponsibilityResponse> {
  return apiJson<FinancialResponsibilityResponse>(`/parties/${id}/financial-responsibility`);
}

export function fetchScore(id: string): Promise<ScoreResponse> {
  return apiJson<ScoreResponse>(`/parties/${id}/score`);
}

export function recomputeScore(id: string): Promise<ScoreResponse> {
  return apiJson<ScoreResponse>(`/parties/${id}/score/recompute`, { method: "POST" });
}
