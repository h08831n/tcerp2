"use client";

import { useCallback, useEffect, useState } from "react";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  fetchAudit,
  productErrorMessage,
  type AuditEntryDto,
  type TemplateDetail,
} from "@/lib/product";

const ACTION_LABELS: Record<string, string> = {
  CREATE: "ایجاد",
  UPDATE: "ویرایش",
  DELETE: "حذف",
  ARCHIVE: "بایگانی",
  VARIANTS_GENERATED: "تولید variants",
};

function actionBadge(action: string) {
  const classes: Record<string, string> = {
    CREATE: "border-emerald-200 bg-emerald-50 text-emerald-700",
    UPDATE: "border-sky-200 bg-sky-50 text-sky-700",
    DELETE: "border-red-200 bg-red-50 text-red-700",
    ARCHIVE: "border-amber-200 bg-amber-50 text-amber-700",
    VARIANTS_GENERATED: "border-violet-200 bg-violet-50 text-violet-700",
  };
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${classes[action] ?? "border-slate-200 bg-slate-100 text-slate-600"}`}>
      {ACTION_LABELS[action] ?? action}
    </span>
  );
}

function summary(entry: AuditEntryDto): string {
  const newValues = entry.newValues as Record<string, unknown> | undefined;
  if (actionLabel(entry.action) === "تولید variants" && newValues) {
    const created = typeof newValues.createdCount === "number" ? newValues.createdCount : null;
    const skipped = typeof newValues.skippedCount === "number" ? newValues.skippedCount : null;
    if (created !== null) {
      return `${faDigits(created)} variant ایجاد شد${skipped !== null ? `، ${faDigits(skipped)} رد شد` : ""}`;
    }
  }
  if (typeof newValues?.nameFa === "string") return newValues.nameFa;
  if (typeof newValues?.sku === "string") return newValues.sku;
  return "";
}

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export function HistoryTab({ template }: { template: TemplateDetail }) {
  const [entries, setEntries] = useState<AuditEntryDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetchAudit({
        entityType: "product_template",
        entityId: template.id,
      });
      setEntries(response.items);
    } catch (err) {
      // audit.view is a separate permission; show a graceful note instead of a hard error.
      setError(productErrorMessage(err));
      setEntries(null);
    } finally {
      setLoading(false);
    }
  }, [template.id]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <p className="py-8 text-center text-sm text-slate-400">در حال بارگذاری تاریخچه…</p>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
        <p className="text-sm font-medium text-slate-500">دسترسی به تاریخچه تغییرات در دسترس نیست.</p>
        <p className="mt-1 text-xs text-slate-400">
          مشاهده تاریخچه نیازمند مجوز «audit.view» است. {error}
        </p>
        <button
          type="button"
          className="mt-3 text-xs text-primary-600 underline"
          onClick={() => void load()}
        >
          تلاش مجدد
        </button>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-slate-400">
        رویدادی برای این محصول ثبت نشده است.
      </p>
    );
  }

  return (
    <ol className="relative space-y-4 ps-6 before:absolute before:inset-y-1 before:start-1.5 before:block before:w-px before:bg-slate-200" aria-label="تاریخچه تغییرات محصول">
      {entries.map((entry) => (
        <li key={entry.id} className="relative">
          <span className="absolute -start-[18px] top-1.5 block h-2.5 w-2.5 rounded-full border-2 border-white bg-primary-500" aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-2">
            {actionBadge(entry.action)}
            <span className="text-sm font-medium text-slate-800">{actionLabel(entry.action)}</span>
            {summary(entry) && (
              <span className="text-xs text-slate-500">{summary(entry)}</span>
            )}
            <span className="ms-auto text-[11px] tabular-nums text-slate-400">
              {jalaliDateTime(entry.createdAt)}
            </span>
          </div>
          {entry.userAgent && (
            <p className="mt-0.5 truncate text-[11px] text-slate-300" dir="ltr">
              {entry.userAgent}
            </p>
          )}
        </li>
      ))}
    </ol>
  );
}
