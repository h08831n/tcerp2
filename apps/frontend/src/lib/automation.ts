/**
 * Automation rules API types and helpers (Phase 5 lean subset of §52).
 * Contract source of truth: apps/backend/src/automation/* controllers + DTOs
 * + automation-rule.service.ts / automation.service.ts.
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";
import { PUBLISH_CHANNEL_LABELS, type PublishChannel } from "@/lib/publishing";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type AutomationTriggerType =
  | "PRICE_UPDATED"
  | "CUSTOMER_INACTIVE_DAYS"
  | "QUOTATION_PENDING_DAYS"
  | "MANUAL";

export const AUTOMATION_TRIGGER_TYPES: AutomationTriggerType[] = [
  "PRICE_UPDATED",
  "CUSTOMER_INACTIVE_DAYS",
  "QUOTATION_PENDING_DAYS",
  "MANUAL",
];

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  PRICE_UPDATED: "به‌روزرسانی قیمت",
  CUSTOMER_INACTIVE_DAYS: "مشتری غیرفعال (X روز)",
  QUOTATION_PENDING_DAYS: "پیش‌فاکتور معلق (X روز)",
  MANUAL: "اجرای دستی",
};

export type AutomationActionType =
  | "PUBLISH_PRICE"
  | "SEND_SMS"
  | "CREATE_ACTIVITY"
  | "CREATE_NOTIFICATION";

export const AUTOMATION_ACTION_TYPES: AutomationActionType[] = [
  "PUBLISH_PRICE",
  "SEND_SMS",
  "CREATE_ACTIVITY",
  "CREATE_NOTIFICATION",
];

export const AUTOMATION_ACTION_LABELS: Record<AutomationActionType, string> = {
  PUBLISH_PRICE: "انتشار قیمت",
  SEND_SMS: "ارسال پیامک",
  CREATE_ACTIVITY: "ایجاد فعالیت",
  CREATE_NOTIFICATION: "ایجاد اعلان",
};

/** Run.status is a free string column; these are the values the backend writes. */
export type AutomationRunStatus = "PENDING" | "SUCCESS" | "FAILED" | "SKIPPED";

export const AUTOMATION_RUN_STATUS_LABELS: Record<string, string> = {
  PENDING: "در انتظار",
  SUCCESS: "موفق",
  FAILED: "ناموفق",
  SKIPPED: "رد شده",
};

export const AUTOMATION_RUN_STATUS_BADGE_CLASSES: Record<string, string> = {
  PENDING: "border-slate-300 bg-slate-100 text-slate-600",
  SUCCESS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  SKIPPED: "border-amber-200 bg-amber-50 text-amber-700",
};

/** Which triggers scan daily and take a `days` number in triggerConfig. */
export const DAY_BASED_TRIGGERS: AutomationTriggerType[] = [
  "CUSTOMER_INACTIVE_DAYS",
  "QUOTATION_PENDING_DAYS",
];

export function isDayBasedTrigger(trigger: AutomationTriggerType): boolean {
  return DAY_BASED_TRIGGERS.includes(trigger);
}

/** Persian translation of well-known backend error tokens. */
export function automationErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message.includes("already exists")) return "این کد قبلاً در این شرکت ثبت شده است.";
    if (message.includes("entityId (variantId) is required"))
      return "برای قاعده به‌روزرسانی قیمت، انتخاب محصول (variant) الزامی است.";
    if (message.includes("Product variant not found")) return "محصول (variant) یافت نشد.";
    if (message.includes("Party not found")) return "مشتری انتخاب‌شده یافت نشد.";
    if (message.includes("Sales document not found")) return "پیش‌فاکتور انتخاب‌شده یافت نشد.";
    if (message.includes("not found")) return "قاعده مورد نظر یافت نشد.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

/** Human summary of a trigger config for the rules list. */
export function triggerConfigSummary(
  triggerType: AutomationTriggerType,
  config: Record<string, unknown> | null,
): string {
  if (!config) return "—";
  if (triggerType === "PRICE_UPDATED") {
    const channels = Array.isArray(config.channels) ? (config.channels as PublishChannel[]) : [];
    if (channels.length === 0) return "همه کانال‌ها (وب‌سایت)";
    return channels.map((channel) => PUBLISH_CHANNEL_LABELS[channel] ?? channel).join("، ");
  }
  if (isDayBasedTrigger(triggerType)) {
    const days = Number(config.days);
    return Number.isFinite(days) ? `${days} روز` : "—";
  }
  return "—";
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface AutomationRuleDto {
  id: string;
  companyId: string;
  code: string;
  nameFa: string;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  conditionConfig: Record<string, unknown> | null;
  actionType: AutomationActionType;
  actionConfig: Record<string, unknown>;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function fetchAutomationRules(): Promise<AutomationRuleDto[]> {
  return apiJson<AutomationRuleDto[]>("/automation/rules");
}

export interface CreateAutomationRuleBody {
  code: string;
  nameFa: string;
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  conditionConfig?: Record<string, unknown>;
  actionType: AutomationActionType;
  actionConfig: Record<string, unknown>;
  enabled?: boolean;
}

export function createAutomationRule(body: CreateAutomationRuleBody): Promise<AutomationRuleDto> {
  return apiJson<AutomationRuleDto>("/automation/rules", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdateAutomationRuleBody {
  nameFa?: string;
  triggerType?: AutomationTriggerType;
  triggerConfig?: Record<string, unknown>;
  conditionConfig?: Record<string, unknown>;
  actionType?: AutomationActionType;
  actionConfig?: Record<string, unknown>;
  enabled?: boolean;
}

export function updateAutomationRule(
  id: string,
  body: UpdateAutomationRuleBody,
): Promise<AutomationRuleDto> {
  return apiJson<AutomationRuleDto>(`/automation/rules/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deleteAutomationRule(id: string): Promise<{ success: boolean }> {
  return apiJson<{ success: boolean }>(`/automation/rules/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export interface AutomationRunDto {
  id: string;
  ruleId: string;
  ruleVersion: number;
  triggerPayload: Record<string, unknown> | null;
  status: string;
  conditionsResult: Record<string, unknown> | null;
  error: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  finishedAt: string | null;
  rule: { code: string; nameFa: string };
}

export interface AutomationRunQuery {
  page?: number;
  pageSize?: number;
  status?: string;
}

export function fetchAutomationRuns(
  ruleId: string,
  query: AutomationRunQuery = {},
): Promise<PaginatedResponse<AutomationRunDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.status) params.set("status", query.status);
  return apiJson<PaginatedResponse<AutomationRunDto>>(
    `/automation/rules/${ruleId}/runs?${params.toString()}`,
  );
}

// ---------------------------------------------------------------------------
// Manual run / daily scan
// ---------------------------------------------------------------------------

export interface ManualRunBody {
  /** variantId (PRICE_UPDATED), partyId (CUSTOMER_INACTIVE_DAYS), documentId (QUOTATION_PENDING_DAYS). */
  entityId?: string;
  /** Scan date for daily rules (defaults to today). */
  date?: string;
}

export interface AutomationRunManualResult {
  runs: AutomationRunDto[];
  summaries?: ScanRuleSummary[];
}

export interface ScanRuleSummary {
  ruleId: string;
  code: string;
  triggerType: string;
  candidates: number;
  executed: number;
  skippedDuplicates: number;
  conditionSkipped: number;
}

export function runAutomationRule(
  ruleId: string,
  body: ManualRunBody = {},
): Promise<AutomationRunManualResult> {
  return apiJson<AutomationRunManualResult>(`/automation/rules/${ruleId}/run`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function runDailyScan(date?: string): Promise<{ date: string | null; summaries: ScanRuleSummary[] }> {
  return apiJson<{ date: string | null; summaries: ScanRuleSummary[] }>(
    "/automation/daily-scan/run",
    { method: "POST", body: JSON.stringify(date ? { date } : {}) },
  );
}

/** Persian one-liner for a scan summary (manual-run result toast). */
export function scanSummaryLine(summary: ScanRuleSummary): string {
  return `کاندید: ${summary.candidates} — اجرا: ${summary.executed} — تکراری: ${summary.skippedDuplicates} — رد شرط: ${summary.conditionSkipped}`;
}
