import { apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ───────────────────────── types ─────────────────────────

export interface NotificationDto {
  id: string;
  userId: string;
  companyId: string | null;
  title: string;
  body: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  priority: "LOW" | "NORMAL" | "HIGH" | "CRITICAL";
  status: "UNREAD" | "READ" | "ARCHIVED";
  createdAt: string;
  readAt: string | null;
}

export interface NotificationRuleDto {
  id: string;
  companyId: string;
  code: string;
  event: string;
  conditions: Record<string, unknown> | null;
  recipientConfig: Array<{ type: string; value: string }>;
  channels: string[];
  delayConfig: { delayMinutes?: number } | null;
  priority: string;
  enabled: boolean;
  createdAt: string;
}

export interface SmsMessageDto {
  id: string;
  to: string;
  text: string;
  status: "QUEUED" | "SENT" | "FAILED";
  source: "AUTOMATION" | "NOTIFICATION_RULE" | "MANUAL";
  sourceId: string | null;
  templateCode: string | null;
  partyId: string | null;
  error: string | null;
  idempotencyKey: string;
  createdAt: string;
  sentAt: string | null;
}

export interface SmsTemplateDto {
  id: string;
  code: string;
  nameFa: string;
  bodyTemplate: string;
  isActive: boolean;
}

// ───────────────────────── inbox ─────────────────────────

export function fetchNotifications(
  input: { status?: string; page?: number; pageSize?: number } = {},
): Promise<PaginatedResponse<NotificationDto>> {
  const params = new URLSearchParams({
    includePlatform: "true",
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? 20),
  });
  if (input.status) params.set("status", input.status);
  return apiJson<PaginatedResponse<NotificationDto>>(`/notifications?${params.toString()}`);
}

export function markNotificationRead(id: string): Promise<{ marked: boolean }> {
  return apiJson(`/notifications/${id}/read`, { method: "POST" });
}

export function markAllNotificationsRead(): Promise<{ marked: number }> {
  return apiJson("/notifications/read-all", { method: "POST" });
}

// ───────────────────────── rules ─────────────────────────

export function fetchNotificationRules(): Promise<NotificationRuleDto[]> {
  return apiJson<NotificationRuleDto[]>("/notifications/rules");
}

export function updateNotificationRule(
  id: string,
  body: { enabled?: boolean },
): Promise<NotificationRuleDto> {
  return apiJson<NotificationRuleDto>(`/notifications/rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteNotificationRule(id: string): Promise<{ success: boolean }> {
  return apiJson(`/notifications/rules/${id}`, { method: "DELETE" });
}

// ───────────────────────── SMS ─────────────────────────

export function fetchSmsMessages(
  input: { status?: string; page?: number; pageSize?: number } = {},
): Promise<PaginatedResponse<SmsMessageDto>> {
  const params = new URLSearchParams({
    page: String(input.page ?? 1),
    pageSize: String(input.pageSize ?? 20),
  });
  if (input.status) params.set("status", input.status);
  return apiJson<PaginatedResponse<SmsMessageDto>>(`/notifications/sms?${params.toString()}`);
}

export function sendSms(body: {
  to: string;
  text?: string;
  templateCode?: string;
  vars?: Record<string, unknown>;
  partyId?: string;
  idempotencyKey?: string;
}): Promise<{ message: SmsMessageDto; created: boolean }> {
  return apiJson("/notifications/sms/send", { method: "POST", body: JSON.stringify(body) });
}

export function resendSms(id: string): Promise<{ message: SmsMessageDto }> {
  return apiJson(`/notifications/sms/${id}/resend`, { method: "POST" });
}

export function fetchSmsTemplates(): Promise<SmsTemplateDto[]> {
  return apiJson<SmsTemplateDto[]>("/notifications/sms-templates");
}

export function createSmsTemplate(body: {
  code: string;
  nameFa: string;
  bodyTemplate: string;
}): Promise<SmsTemplateDto> {
  return apiJson("/notifications/sms-templates", { method: "POST", body: JSON.stringify(body) });
}

export function updateSmsTemplate(
  id: string,
  body: { nameFa?: string; bodyTemplate?: string; isActive?: boolean },
): Promise<SmsTemplateDto> {
  return apiJson(`/notifications/sms-templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteSmsTemplate(id: string): Promise<{ success: boolean }> {
  return apiJson(`/notifications/sms-templates/${id}`, { method: "DELETE" });
}
