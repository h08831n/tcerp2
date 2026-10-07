"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  AUTOMATION_ACTION_LABELS,
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_RUN_STATUS_BADGE_CLASSES,
  AUTOMATION_RUN_STATUS_LABELS,
  AUTOMATION_TRIGGER_LABELS,
  AUTOMATION_TRIGGER_TYPES,
  automationErrorMessage,
  createAutomationRule,
  fetchAutomationRules,
  fetchAutomationRuns,
  isDayBasedTrigger,
  runAutomationRule,
  scanSummaryLine,
  triggerConfigSummary,
  updateAutomationRule,
  type AutomationActionType,
  type AutomationRuleDto,
  type AutomationRunDto,
  type AutomationTriggerType,
  type ScanRuleSummary,
} from "@/lib/automation";
import { PUBLISH_CHANNELS, PUBLISH_CHANNEL_LABELS, type PublishChannel } from "@/lib/publishing";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";
const selectClass =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20";

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function RunStatusBadge({ status }: { status: string }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${
        AUTOMATION_RUN_STATUS_BADGE_CLASSES[status] ?? "border-slate-300 bg-slate-100 text-slate-600"
      }`}
    >
      {AUTOMATION_RUN_STATUS_LABELS[status] ?? status}
    </span>
  );
}

interface RuleFormState {
  mode: "create" | "edit";
  rule: AutomationRuleDto | null;
  code: string;
  nameFa: string;
  triggerType: AutomationTriggerType;
  channels: PublishChannel[];
  days: string;
  actionType: AutomationActionType;
  enabled: boolean;
}

function openCreateForm(): RuleFormState {
  return {
    mode: "create",
    rule: null,
    code: "",
    nameFa: "",
    triggerType: "PRICE_UPDATED",
    channels: ["WEBSITE"],
    days: "60",
    actionType: "PUBLISH_PRICE",
    enabled: true,
  };
}

function openEditForm(rule: AutomationRuleDto): RuleFormState {
  const config = rule.triggerConfig ?? {};
  return {
    mode: "edit",
    rule,
    code: rule.code,
    nameFa: rule.nameFa,
    triggerType: rule.triggerType,
    channels: Array.isArray(config.channels) ? (config.channels as PublishChannel[]) : [],
    days: config.days !== undefined ? String(config.days) : "60",
    actionType: rule.actionType,
    enabled: rule.enabled,
  };
}

interface ManualRunTarget {
  rule: AutomationRuleDto;
  variant: VariantSelection | null;
}

interface ManualRunResult {
  runs: AutomationRunDto[];
  summaries?: ScanRuleSummary[];
}

export default function AutomationPage() {
  const [rules, setRules] = useState<AutomationRuleDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Editor modal
  const [form, setForm] = useState<RuleFormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Runs drawer
  const [runsRule, setRunsRule] = useState<AutomationRuleDto | null>(null);
  const [runs, setRuns] = useState<AutomationRunDto[]>([]);
  const [runsTotal, setRunsTotal] = useState(0);
  const [runsPage, setRunsPage] = useState(1);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);

  // Manual run
  const [runTarget, setRunTarget] = useState<ManualRunTarget | null>(null);
  const [running, setRunning] = useState(false);
  const [runModalError, setRunModalError] = useState<string | null>(null);
  const [runResult, setRunResult] = useState<{ rule: AutomationRuleDto; result: ManualRunResult } | null>(
    null,
  );

  const runsPageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRules(await fetchAutomationRules());
    } catch (err) {
      setError(automationErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ── runs drawer data ──

  const loadRuns = useCallback(
    async (ruleId: string, page: number, append: boolean) => {
      setRunsLoading(true);
      if (!append) setRunsError(null);
      try {
        const response = await fetchAutomationRuns(ruleId, { page, pageSize: runsPageSize });
        setRunsTotal(response.total);
        setRunsPage(page);
        setRuns((current) =>
          append ? [...current, ...response.items] : response.items,
        );
      } catch (err) {
        setRunsError(automationErrorMessage(err));
      } finally {
        setRunsLoading(false);
      }
    },
    [runsPageSize],
  );

  function openRuns(rule: AutomationRuleDto) {
    setRunsRule(rule);
    setRuns([]);
    setRunsTotal(0);
    setRunsError(null);
    void loadRuns(rule.id, 1, false);
  }

  function closeRuns() {
    setRunsRule(null);
  }

  // Esc closes the runs drawer.
  useEffect(() => {
    if (!runsRule) return;
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRuns();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [runsRule]);

  // ── editor ──

  async function saveForm() {
    if (!form || saving) return;
    if (form.mode === "create" && !form.code.trim()) {
      setFormError("کد قاعده الزامی است.");
      return;
    }
    if (!form.nameFa.trim()) {
      setFormError("نام قاعده الزامی است.");
      return;
    }
    if (form.triggerType === "PRICE_UPDATED" && form.channels.length === 0) {
      setFormError("برای تریگر به‌روزرسانی قیمت، حداقل یک کانال انتخاب کنید.");
      return;
    }
    const triggerConfig: Record<string, unknown> =
      form.triggerType === "PRICE_UPDATED"
        ? { channels: form.channels }
        : isDayBasedTrigger(form.triggerType)
          ? { days: Math.max(1, Math.trunc(Number(form.days) || 0)) }
          : {};
    if (isDayBasedTrigger(form.triggerType) && !(Number(form.days) >= 1)) {
      setFormError("تعداد روز باید عددی بزرگ‌تر از صفر باشد.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (form.mode === "create") {
        await createAutomationRule({
          code: form.code.trim(),
          nameFa: form.nameFa.trim(),
          triggerType: form.triggerType,
          triggerConfig,
          actionType: form.actionType,
          actionConfig: {},
          enabled: form.enabled,
        });
        setNotice("قاعده خودکارسازی ساخته شد.");
      } else if (form.rule) {
        await updateAutomationRule(form.rule.id, {
          nameFa: form.nameFa.trim(),
          triggerType: form.triggerType,
          triggerConfig,
          actionType: form.actionType,
          enabled: form.enabled,
        });
        setNotice("قاعده خودکارسازی به‌روزرسانی شد.");
      }
      setForm(null);
      await load();
    } catch (err) {
      setFormError(automationErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(rule: AutomationRuleDto) {
    setTogglingId(rule.id);
    setError(null);
    try {
      await updateAutomationRule(rule.id, { enabled: !rule.enabled });
      await load();
    } catch (err) {
      setError(automationErrorMessage(err));
    } finally {
      setTogglingId(null);
    }
  }

  // ── manual run ──

  function openManualRun(rule: AutomationRuleDto) {
    setRunModalError(null);
    setRunTarget({ rule, variant: null });
  }

  async function executeManualRun() {
    if (!runTarget || running) return;
    const { rule, variant } = runTarget;
    if (rule.triggerType === "PRICE_UPDATED" && !variant) {
      setRunModalError("برای قاعده به‌روزرسانی قیمت، انتخاب محصول (variant) الزامی است.");
      return;
    }
    setRunning(true);
    setRunModalError(null);
    try {
      const result = await runAutomationRule(rule.id, {
        ...(variant ? { entityId: variant.variantId } : {}),
      });
      setRunTarget(null);
      setRunResult({ rule, result });
    } catch (err) {
      setRunModalError(automationErrorMessage(err));
    } finally {
      setRunning(false);
    }
  }

  // Ctrl+S saves the open editor.
  function handleFormKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveForm();
    }
  }

  // ── table ──

  const columns = useMemo<DataTableColumn<AutomationRuleDto>[]>(
    () => [
      {
        key: "name",
        header: "نام",
        render: (row) => (
          <div className="min-w-40">
            <p className="text-xs font-semibold text-slate-800">{row.nameFa}</p>
            <span dir="ltr" className="font-mono text-[10px] text-slate-400">
              {row.code}
            </span>
          </div>
        ),
      },
      {
        key: "trigger",
        header: "تریگر",
        render: (row) => (
          <div className="min-w-40">
            <span className="text-xs text-slate-700">
              {AUTOMATION_TRIGGER_LABELS[row.triggerType] ?? row.triggerType}
            </span>
            <span className="block text-[11px] text-slate-400">
              {triggerConfigSummary(row.triggerType, row.triggerConfig)}
            </span>
          </div>
        ),
      },
      {
        key: "action",
        header: "اکشن",
        render: (row) => (
          <span className="text-xs text-slate-600">
            {AUTOMATION_ACTION_LABELS[row.actionType] ?? row.actionType}
          </span>
        ),
      },
      {
        key: "enabled",
        header: "فعال",
        align: "center",
        render: (row) => (
          <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
            <input
              type="checkbox"
              checked={row.enabled}
              disabled={togglingId === row.id}
              onChange={() => void toggleEnabled(row)}
              className="h-4 w-4 accent-primary-600"
              aria-label={`فعال بودن قاعده ${row.nameFa}`}
            />
            {row.enabled ? "فعال" : "غیرفعال"}
          </label>
        ),
      },
      {
        key: "updatedAt",
        header: "آخرین تغییر",
        render: (row) => (
          <span className="text-[11px] tabular-nums text-slate-400">
            {jalaliDateTime(row.updatedAt)}
          </span>
        ),
      },
      {
        key: "runs",
        header: "آخرین اجراها",
        align: "center",
        render: (row) => (
          <div className="flex flex-wrap items-center justify-center gap-1">
            <Button size="sm" variant="secondary" onClick={() => openRuns(row)}>
              اجرای‌ها
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => openManualRun(row)}
              aria-label={`اجرای دستی ${row.nameFa}`}
            >
              اجرای دستی
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setForm(openEditForm(row))}>
              ویرایش
            </Button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [togglingId],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">قواعد خودکارسازی</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            قواعد رویدادمحور و روزانه — هر اجرا با کلید idempotency ثبت می‌شود تا تکراری اجرا نشود.
          </p>
        </div>
        <Button onClick={() => setForm(openCreateForm())} aria-label="قاعده خودکارسازی جدید">
          قاعده جدید
        </Button>
      </div>

      {notice && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <DataTable<AutomationRuleDto>
        columns={columns}
        rows={rules}
        rowKey={(row) => row.id}
        loading={loading}
        dense
        ariaLabel="فهرست قواعد خودکارسازی"
        emptyMessage="هنوز قاعده‌ای ساخته نشده است."
      />

      {/* Create / edit rule */}
      <Modal
        open={form !== null}
        title={form?.mode === "create" ? "قاعده خودکارسازی جدید" : `ویرایش قاعده ${form?.nameFa ?? ""}`}
        onClose={() => setForm(null)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setForm(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void saveForm()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-4" onKeyDown={handleFormKeyDown}>
            {formError && (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {formError}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="rule-code" className={fieldLabel}>
                  کد {form.mode === "edit" ? "(غیرقابل تغییر)" : ""}
                </label>
                <Input
                  id="rule-code"
                  dir="ltr"
                  value={form.code}
                  disabled={form.mode === "edit"}
                  onChange={(event) => setForm({ ...form, code: event.target.value })}
                  placeholder="daily_price_publish"
                />
              </div>
              <div>
                <label htmlFor="rule-name" className={fieldLabel}>
                  نام فارسی
                </label>
                <Input
                  id="rule-name"
                  value={form.nameFa}
                  onChange={(event) => setForm({ ...form, nameFa: event.target.value })}
                  placeholder="انتشار قیمت روز"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label htmlFor="rule-trigger" className={fieldLabel}>
                  تریگر
                </label>
                <select
                  id="rule-trigger"
                  value={form.triggerType}
                  onChange={(event) =>
                    setForm({ ...form, triggerType: event.target.value as AutomationTriggerType })
                  }
                  className={selectClass}
                >
                  {AUTOMATION_TRIGGER_TYPES.map((trigger) => (
                    <option key={trigger} value={trigger}>
                      {AUTOMATION_TRIGGER_LABELS[trigger]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="rule-action" className={fieldLabel}>
                  اکشن
                </label>
                <select
                  id="rule-action"
                  value={form.actionType}
                  onChange={(event) =>
                    setForm({ ...form, actionType: event.target.value as AutomationActionType })
                  }
                  className={selectClass}
                >
                  {AUTOMATION_ACTION_TYPES.map((action) => (
                    <option key={action} value={action}>
                      {AUTOMATION_ACTION_LABELS[action]}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Per-trigger config */}
            {form.triggerType === "PRICE_UPDATED" && (
              <fieldset className="rounded-lg border border-slate-200 p-3">
                <legend className="px-1 text-xs font-medium text-slate-600">
                  کانال‌های انتشار (پیکربندی تریگر)
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-2">
                  {PUBLISH_CHANNELS.map((channel) => (
                    <label
                      key={channel}
                      className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-700"
                    >
                      <input
                        type="checkbox"
                        checked={form.channels.includes(channel)}
                        onChange={(event) =>
                          setForm({
                            ...form,
                            channels: event.target.checked
                              ? [...form.channels, channel]
                              : form.channels.filter((item) => item !== channel),
                          })
                        }
                        className="h-4 w-4 accent-primary-600"
                      />
                      {PUBLISH_CHANNEL_LABELS[channel]}
                    </label>
                  ))}
                </div>
                <p className="mt-2 text-[11px] text-slate-400">
                  در رویداد به‌روزرسانی قیمت، انتشار به این کانال‌ها برای همان محصول و همان روز انجام می‌شود.
                </p>
              </fieldset>
            )}
            {isDayBasedTrigger(form.triggerType) && (
              <div className="max-w-40">
                <label htmlFor="rule-days" className={fieldLabel}>
                  تعداد روز
                </label>
                <Input
                  id="rule-days"
                  dir="ltr"
                  inputMode="numeric"
                  value={form.days}
                  onChange={(event) => setForm({ ...form, days: event.target.value })}
                  aria-label="تعداد روز برای تریگر روزانه"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  {form.triggerType === "CUSTOMER_INACTIVE_DAYS"
                    ? "مشتریانی که آخرین خریدشان قدیمی‌تر از این تعداد روز است."
                    : "پیش‌فاکتورهایی که از تاریخ سندشان این تعداد روز گذشته و معلق مانده‌اند."}
                </p>
              </div>
            )}

            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                className="h-4 w-4 accent-primary-600"
              />
              قاعده فعال باشد
            </label>
          </div>
        )}
      </Modal>

      {/* Manual run modal */}
      <Modal
        open={runTarget !== null}
        title={`اجرای دستی — ${runTarget?.rule.nameFa ?? ""}`}
        onClose={() => setRunTarget(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRunTarget(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void executeManualRun()} disabled={running}>
              {running ? "در حال اجرا…" : "اجرای دستی"}
            </Button>
          </>
        }
      >
        {runTarget && (
          <div className="space-y-3">
            {runModalError && (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {runModalError}
              </div>
            )}
            {runTarget.rule.triggerType === "PRICE_UPDATED" ? (
              <>
                <p className="text-sm text-slate-700">
                  محصولی را انتخاب کنید تا رویداد به‌روزرسانی قیمت به‌صورت دستی برای آن اجرا شود.
                </p>
                <VariantSelector
                  value={runTarget.variant}
                  onChange={(variant) => setRunTarget({ ...runTarget, variant })}
                />
              </>
            ) : isDayBasedTrigger(runTarget.rule.triggerType) ? (
              <p className="text-sm text-slate-700">
                اسکن کامل این قاعده روی همه رکوردهای کاندید اجرا شود؟ اجراهای تکراری امروز به‌صورت خودکار رد می‌شوند.
              </p>
            ) : (
              <p className="text-sm text-slate-700">این قاعده اکنون اجرا شود؟</p>
            )}
          </div>
        )}
      </Modal>

      {/* Manual run result */}
      <Modal
        open={runResult !== null}
        title="نتیجه اجرای دستی"
        onClose={() => setRunResult(null)}
        footer={
          <>
            {runResult && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  const rule = runResult.rule;
                  setRunResult(null);
                  openRuns(rule);
                }}
              >
                مشاهده اجرای‌ها
              </Button>
            )}
            <Button size="sm" onClick={() => setRunResult(null)}>
              بستن
            </Button>
          </>
        }
      >
        {runResult && (
          <div className="space-y-3">
            {runResult.result.runs.map((run) => (
              <div key={run.id} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2">
                <RunStatusBadge status={run.status} />
                {run.idempotencyKey && (
                  <span dir="ltr" className="max-w-56 truncate font-mono text-[10px] text-slate-400">
                    {run.idempotencyKey}
                  </span>
                )}
              </div>
            ))}
            {runResult.result.summaries?.map((summary) => (
              <p key={summary.ruleId} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                {scanSummaryLine(summary)}
              </p>
            ))}
            {runResult.result.runs.length === 0 && (runResult.result.summaries?.length ?? 0) === 0 && (
              <p className="text-sm text-slate-500">اجرایی ثبت نشد.</p>
            )}
            <p className="text-[11px] text-slate-400">
              اجراهای در صف بعد از پردازش، در فهرست «اجرای‌ها» وضعیت نهایی می‌گیرند.
            </p>
          </div>
        )}
      </Modal>

      {/* Runs drawer */}
      {runsRule && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={closeRuns}
            className="absolute inset-0 cursor-default bg-slate-900/40"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={`اجرای‌های قاعده ${runsRule.nameFa}`}
            className="absolute inset-y-0 end-0 flex w-full max-w-lg flex-col border-s border-slate-200 bg-white shadow-xl"
          >
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold text-slate-800">
                  اجرای‌های «{runsRule.nameFa}»
                </h3>
                <p className="text-[11px] text-slate-400">
                  {AUTOMATION_TRIGGER_LABELS[runsRule.triggerType] ?? runsRule.triggerType} — نسخه فعلی قاعده{" "}
                  {faDigits(runsRule.version)}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadRuns(runsRule.id, 1, false)}
                  disabled={runsLoading}
                  aria-label="بازخوانی اجرای‌ها"
                >
                  بازخوانی
                </Button>
                <button
                  type="button"
                  onClick={closeRuns}
                  aria-label="بستن (Esc)"
                  className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className="h-4 w-4"
                    aria-hidden="true"
                  >
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3">
              {runsError && (
                <div role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {runsError}
                </div>
              )}
              {runsLoading && runs.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">در حال بارگذاری اجرای‌ها…</p>
              ) : runs.length === 0 ? (
                <p className="py-8 text-center text-sm text-slate-400">
                  این قاعده هنوز اجرا نشده است.
                </p>
              ) : (
                <ul className="space-y-3">
                  {runs.map((run) => (
                    <li key={run.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <RunStatusBadge status={run.status} />
                        <span className="text-[11px] tabular-nums text-slate-400">
                          {jalaliDateTime(run.createdAt)}
                          {run.finishedAt ? ` → ${jalaliDateTime(run.finishedAt)}` : ""}
                        </span>
                      </div>
                      <div className="mt-2 space-y-1 text-[11px] text-slate-500">
                        <p>
                          <span className="font-medium text-slate-600">کلید idempotency: </span>
                          {run.idempotencyKey ? (
                            <span dir="ltr" className="break-all font-mono text-slate-600">
                              {run.idempotencyKey}
                            </span>
                          ) : (
                            "—"
                          )}
                        </p>
                        <p>
                          <span className="font-medium text-slate-600">نسخه قاعده: </span>
                          {faDigits(run.ruleVersion)}
                        </p>
                      </div>
                      {run.conditionsResult && (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-[11px] font-medium text-primary-700">
                            نتیجه شرایط
                          </summary>
                          <pre
                            dir="ltr"
                            className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-slate-200 bg-slate-50 p-2 text-[10px] text-slate-600"
                          >
                            {prettyJson(run.conditionsResult)}
                          </pre>
                        </details>
                      )}
                      {run.error && (
                        <div className="mt-2">
                          <p className="text-[11px] font-bold text-red-600">خطا</p>
                          <pre
                            dir="ltr"
                            className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-red-100 bg-red-50/60 p-2 text-[10px] text-red-700"
                          >
                            {run.error}
                          </pre>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {runs.length < runsTotal && (
                <div className="mt-3 text-center">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={runsLoading}
                    onClick={() => void loadRuns(runsRule.id, runsPage + 1, true)}
                  >
                    {runsLoading ? "…" : `نمایش بیشتر (${faDigits(runsTotal - runs.length)} مورد دیگر)`}
                  </Button>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
