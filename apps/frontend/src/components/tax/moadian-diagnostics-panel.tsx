"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { faDigits } from "@/lib/format";
import {
  DIAGNOSTIC_STATUS_CLASSES,
  DIAGNOSTIC_STATUS_LABELS,
  DIAGNOSTIC_STEP_LABELS,
  MOADIAN_MODE_LABELS,
  fetchConnectionDiagnostics,
  runSandboxFullTest,
  type DiagnosticReport,
  type DiagnosticStepStatus,
} from "@/lib/moadian-diagnostics";

type RunResult = DiagnosticReport & { submission?: { status: string; detail: string } | null; errorCode?: string | null };

const OVERALL_LABELS: Record<string, { label: string; classes: string }> = {
  PASS: { label: "اتصال موفق", classes: "border-emerald-200 bg-emerald-50 text-emerald-800" },
  FAIL: { label: "اتصال ناموفق", classes: "border-rose-200 bg-rose-50 text-rose-800" },
  NOT_CONFIGURED: { label: "تنظیم نشده", classes: "border-amber-200 bg-amber-50 text-amber-800" },
};

const STEP_STATUS_CLASSES: Record<DiagnosticStepStatus, string> = {
  PASS: "bg-emerald-100 text-emerald-800",
  FAIL: "bg-rose-100 text-rose-800",
  SKIPPED: "bg-slate-100 text-slate-600",
  NOT_CONFIGURED: "bg-amber-100 text-amber-800",
};

/** پنل «تست اتصال به سامانه مؤدیان» — administrator-only diagnostics. */
export function MoadianDiagnosticsPanel() {
  const [running, setRunning] = useState(false);
  const [sandboxConfirm, setSandboxConfirm] = useState(false);
  const [sandboxRunning, setSandboxRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [sandboxResult, setSandboxResult] = useState<RunResult | null>(null);
  const [rateLimited, setRateLimited] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runConnection = async () => {
    setError(null);
    setRateLimited(null);
    setRunning(true);
    try {
      const res = (await fetchConnectionDiagnostics()) as RunResult;
      if ((res as { status?: string }).status === "RUN_RATE_LIMITED") {
        setRateLimited((res as unknown as { waitSeconds: number }).waitSeconds);
      } else {
        setResult(res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در اجرای تست اتصال.");
    } finally {
      setRunning(false);
    }
  };

  const runSandbox = async () => {
    setError(null);
    setRateLimited(null);
    setSandboxConfirm(false);
    setSandboxRunning(true);
    try {
      const res = (await runSandboxFullTest()) as RunResult;
      if ((res as { status?: string }).status === "RUN_RATE_LIMITED") {
        setRateLimited((res as unknown as { waitSeconds: number }).waitSeconds);
      } else {
        setSandboxResult(res);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "خطا در اجرای آزمون کامل.");
    } finally {
      setSandboxRunning(false);
    }
  };

  const renderSteps = (report: RunResult) => (
    <div className="space-y-2">
      {report.steps.map((s) => (
        <div key={s.step + s.timestamp} className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-800">
              {DIAGNOSTIC_STEP_LABELS[s.step] ?? s.step}
            </span>
            <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STEP_STATUS_CLASSES[s.status]}`}>
              {DIAGNOSTIC_STATUS_LABELS[s.status]}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-600">{s.message}</div>
          <div className="mt-1 flex flex-wrap gap-x-4 text-[11px] text-slate-400">
            <span>{faDigits(s.durationMs)} ms</span>
            {s.errorCode && <span className="text-rose-600">کد خطا: {s.errorCode}</span>}
          </div>
          {s.remediation && (
            <div className="mt-1 text-[11px] text-amber-700">راهنما: {s.remediation}</div>
          )}
        </div>
      ))}
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 space-y-4">
      <h3 className="text-sm font-semibold text-slate-900">تست اتصال به سامانه مؤدیان</h3>
      <p className="text-xs leading-5 text-slate-500">
        این تست فقط عملیات غیرتغییردهندهٔ مستند را به ترتیب اجرا می‌کند: اعتبارسنجی تنظیمات، دسترسی شبکه،
        دریافت nonce، احراز هویت و دریافت اطلاعات سرور. هیچ صورتحسابی ارسال نمی‌شود.
      </p>
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}
      {rateLimited !== null && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          اجرای مکرر مجاز نیست — پس از {faDigits(rateLimited)} ثانیه دوباره تلاش کنید.
        </div>
      )}

      {result && (
        <div className="space-y-2">
          <div className={`rounded-lg border p-3 text-sm font-medium ${OVERALL_LABELS[result.overall].classes}`}>
            نتیجه کلی ({MOADIAN_MODE_LABELS[result.mode] ?? result.mode}): {OVERALL_LABELS[result.overall].label}
          </div>
          {result.overall === "NOT_CONFIGURED" && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              حالت فعلی {MOADIAN_MODE_LABELS[result.mode] ?? result.mode} است — موفقیت mock/simulation هرگز
              اثبات اتصال واقعی نیست.
            </div>
          )}
          {renderSteps(result)}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => void runConnection()} disabled={running}>
          {running ? "در حال اجرا…" : "تست اتصال"}
        </Button>
        {result?.mode === "sandbox" && result.overall === "PASS" && (
          <Button variant="danger" onClick={() => setSandboxConfirm(true)} disabled={sandboxRunning}>
            اجرای آزمون کامل محیط آزمایشی
          </Button>
        )}
      </div>

      {sandboxResult && (
        <div className="space-y-2 rounded-lg border border-slate-300 p-3">
          <div className={`rounded-lg border p-3 text-sm font-medium ${OVERALL_LABELS[sandboxResult.overall].classes}`}>
            نتیجه آزمون کامل محیط آزمایشی: {OVERALL_LABELS[sandboxResult.overall].label}
          </div>
          {sandboxResult.submission && (
            <div className="text-xs text-slate-600">
              وضعیت ارسال: {sandboxResult.submission.status} — شناسه پیگیری:
              {" "}
              {(sandboxResult.submission as unknown as { referenceNumber?: string }).referenceNumber ?? "—"}
              <div className="mt-1">{sandboxResult.submission.detail}</div>
            </div>
          )}
          {renderSteps(sandboxResult)}
        </div>
      )}

      <Modal
        open={sandboxConfirm}
        title="هشدار — آزمون کامل محیط آزمایشی"
        onClose={() => setSandboxConfirm(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setSandboxConfirm(false)} disabled={sandboxRunning}>
              انصراف
            </Button>
            <Button variant="danger" onClick={() => void runSandbox()} disabled={sandboxRunning}>
              ارسال به محیط آزمایشی
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-6 text-slate-700">
          این آزمون یک صورتحساب <span className="font-medium">آزمایشی</span> به محیط آزمایشی سامانه مؤدیان
          ارسال می‌کند و یک رکورد آزمایشی در سامانه ایجاد می‌نماید. این کار فقط پس از موفقیت تست اتصال و با
          اعتبارنامه آزمایشی مجاز معنا دارد. ادامه می‌دهید؟
        </p>
      </Modal>
    </div>
  );
}
