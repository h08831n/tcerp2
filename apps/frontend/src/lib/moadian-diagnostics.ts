/** Moadian connection diagnostics (Phase 8) — admin-only API layer. */

import { apiJson } from "@/lib/api";

export type DiagnosticStepStatus = "PASS" | "FAIL" | "SKIPPED" | "NOT_CONFIGURED";

export interface DiagnosticStep {
  step: string;
  status: DiagnosticStepStatus;
  errorCode: string | null;
  message: string;
  durationMs: number;
  timestamp: string;
  remediation?: string;
}

export interface DiagnosticReport {
  mode: "mock" | "sandbox" | "live";
  overall: "PASS" | "FAIL" | "NOT_CONFIGURED";
  baseUrl: string;
  steps: DiagnosticStep[];
  finishedAt: string;
}

export interface SandboxTestResult extends DiagnosticReport {
  submission: {
    uid: string;
    status: string;
    referenceNumber: string | null;
    detail: string;
  } | null;
  errorCode?: string | null;
}

export const DIAGNOSTIC_STEP_LABELS: Record<string, string> = {
  configuration: "اعتبارسنجی تنظیمات",
  network: "دسترسی شبکه",
  nonce: "دریافت nonce",
  authentication: "احراز هویت",
  server_information: "اطلاعات سرور",
  read_only_operations: "عملیات خواندنی",
  sandbox_prepare: "آماده‌سازی packet آزمایشی",
  sandbox_enqueue: "ارسال به محیط آزمایشی",
  sandbox_inquiry: "استعلام وضعیت آزمایشی",
};

export const DIAGNOSTIC_STATUS_LABELS: Record<DiagnosticStepStatus, string> = {
  PASS: "موفق",
  FAIL: "ناموفق",
  SKIPPED: "انجام نشد",
  NOT_CONFIGURED: "تنظیم نشده",
};

export const DIAGNOSTIC_STATUS_CLASSES: Record<DiagnosticStepStatus, string> = {
  PASS: "bg-emerald-100 text-emerald-800",
  FAIL: "bg-rose-100 text-rose-800",
  SKIPPED: "bg-slate-100 text-slate-600",
  NOT_CONFIGURED: "bg-amber-100 text-amber-800",
};

export const MOADIAN_MODE_LABELS: Record<string, string> = {
  mock: "شبیه‌ساز (mock)",
  sandbox: "محیط آزمایشی (sandbox)",
  live: "سامانه واقعی (live)",
};

export function fetchConnectionDiagnostics(): Promise<DiagnosticReport | { status: "RUN_RATE_LIMITED"; waitSeconds: number }> {
  return apiJson(`/tax/diagnostics/connection`);
}

export function runSandboxFullTest(): Promise<SandboxTestResult | { status: "RUN_RATE_LIMITED"; waitSeconds: number }> {
  return apiJson(`/tax/diagnostics/sandbox-full-test`, { method: "POST" });
}
