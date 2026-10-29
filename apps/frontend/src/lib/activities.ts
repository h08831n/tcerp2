import { apiJson } from "./api";

/** Phase 9A — Activity Engine (REQUIREMENTS §49) API layer. */

export type ActivityPriority = "LOW" | "NORMAL" | "HIGH" | "URGENT";
export type ActivityStatus = "PENDING" | "COMPLETED" | "CANCELLED";

export interface ActivityTypeRow {
  id: string;
  code: string;
  nameFa: string;
  color: string | null;
}

export interface ActivityRow {
  id: string;
  title: string;
  description: string | null;
  relatedEntityType: string;
  relatedEntityId: string;
  assignedTo: { id: string; username: string; firstName: string | null; lastName: string | null } | null;
  priority: ActivityPriority;
  scheduledDate: string | null;
  dueDate: string | null;
  status: ActivityStatus;
  completedAt: string | null;
  overdue: boolean;
  type: { code: string; nameFa: string; color: string | null };
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export const ACTIVITY_PRIORITY_LABELS: Record<ActivityPriority, string> = {
  LOW: "کم",
  NORMAL: "معمولی",
  HIGH: "زیاد",
  URGENT: "فوری",
};

export const ACTIVITY_STATUS_LABELS: Record<ActivityStatus, string> = {
  PENDING: "در جریان",
  COMPLETED: "تکمیل‌شده",
  CANCELLED: "لغو‌شده",
};

export const ACTIVITY_STATUS_CLASSES: Record<ActivityStatus, string> = {
  PENDING: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-slate-200 text-slate-600",
};

export const ACTIVITY_PRIORITY_CLASSES: Record<ActivityPriority, string> = {
  LOW: "bg-slate-100 text-slate-600",
  NORMAL: "bg-blue-100 text-blue-800",
  HIGH: "bg-orange-100 text-orange-800",
  URGENT: "bg-red-100 text-red-800",
};

export const RELATED_ENTITY_LABELS: Record<string, string> = {
  party: "طرف حساب",
  lead: "سرنخ",
  opportunity: "فرصت",
  sales_document: "سند فروش",
  purchase_document: "سند خرید",
  price_request: "درخواست قیمت",
  loading: "بارگیری",
  payment: "پرداخت",
  check: "چک",
  tax_invoice: "صورتحساب مالیاتی",
  approval_request: "درخواست تأیید",
};

export function activityErrorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "خطایی در ارتباط با سرور رخ داد.";
}

export function fetchActivityTypes(): Promise<ActivityTypeRow[]> {
  return apiJson(`/activities/types`);
}

export function createActivityType(input: { code: string; nameFa: string; color?: string }): Promise<ActivityTypeRow> {
  return apiJson(`/activities/types`, { method: "POST", body: JSON.stringify(input) });
}

export function fetchActivities(query: {
  status?: ActivityStatus | "";
  priority?: ActivityPriority | "";
  typeCode?: string;
  assignedToId?: string;
  overdueOnly?: boolean;
  dueFrom?: string;
  dueTo?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<ActivityRow>> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.priority) params.set("priority", query.priority);
  if (query.typeCode) params.set("typeCode", query.typeCode);
  if (query.assignedToId) params.set("assignedToId", query.assignedToId);
  if (query.overdueOnly) params.set("overdueOnly", "true");
  if (query.dueFrom) params.set("dueFrom", query.dueFrom);
  if (query.dueTo) params.set("dueTo", query.dueTo);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  return apiJson(`/activities?${params.toString()}`);
}

export function createActivity(input: {
  typeCode: string;
  title: string;
  description?: string;
  relatedEntityType: string;
  relatedEntityId: string;
  assignedToId?: string;
  priority?: ActivityPriority;
  scheduledDate?: string;
  dueDate?: string;
}): Promise<{ id: string }> {
  return apiJson(`/activities`, { method: "POST", body: JSON.stringify(input) });
}

export function updateActivity(
  id: string,
  input: {
    title?: string;
    description?: string;
    assignedToId?: string | null;
    priority?: ActivityPriority;
    scheduledDate?: string | null;
    dueDate?: string | null;
    overrideReason?: string;
  },
): Promise<void> {
  return apiJson(`/activities/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function completeActivity(id: string, note?: string): Promise<{ status: string }> {
  return apiJson(`/activities/${id}/complete`, { method: "POST", body: JSON.stringify({ note }) });
}

export function cancelActivity(id: string, reason: string): Promise<{ status: string }> {
  return apiJson(`/activities/${id}/cancel`, { method: "POST", body: JSON.stringify({ reason }) });
}

export function deleteActivity(id: string): Promise<void> {
  return apiJson(`/activities/${id}`, { method: "DELETE" });
}

export interface CalendarLayerEvent {
  id: string;
  kind: string; // activity | check | payment | approval
  title: string;
  date: string;
  status: string;
  entityId: string;
  entityType: string | null;
  extra: Record<string, unknown>;
}

export function fetchCalendarRange(input: {
  from: string;
  to: string;
  layers: string[];
  assignedToId?: string;
}): Promise<{ layers: Record<string, CalendarLayerEvent[]> }> {
  return apiJson(`/activities/calendar`, {
    method: "POST",
    body: JSON.stringify({ from: input.from, to: input.to, layers: input.layers }),
  });
}
