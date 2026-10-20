"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { JournalEntryModal } from "@/components/accounting/journal-entry-modal";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  accountingErrorMessage,
  EVENT_STATUS_LABELS,
  EVENT_TYPE_LABELS,
  fetchAccountingEvents,
  fetchPostingRules,
  retryAccountingEvent,
  type AccountingEventRow,
  type EventsQuery,
  type PostingRule,
} from "@/lib/accounting";

const STATUS_CLASSES: Record<string, string> = {
  POSTED: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
  SKIPPED: "bg-slate-100 text-slate-700",
};

type Tab = "events" | "rules";

/** رویدادها و قواعد ثبت (Phase 7B endpoints) — review + retry failed events. */
export default function AccountingEventsPage() {
  const [tab, setTab] = useState<Tab>("events");
  const [rows, setRows] = useState<AccountingEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<"" | EventsQuery["status"]>("");
  const [rules, setRules] = useState<PostingRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [drillEntryId, setDrillEntryId] = useState<string | null>(null);
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchAccountingEvents({
        status: statusFilter || undefined,
        page,
        pageSize,
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  const loadRules = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRules(await fetchPostingRules());
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "events") void load();
    else void loadRules();
  }, [tab, load, loadRules]);

  const retry = async (id: string) => {
    setError(null);
    setNotice(null);
    setRetryingId(id);
    try {
      const res = await retryAccountingEvent(id);
      setNotice(
        res.status === "POSTED"
          ? "رویداد با موفقیت ثبت شد."
          : `وضعیت رویداد: ${EVENT_STATUS_LABELS[res.status] ?? res.status}${res.error ? ` — ${res.error}` : ""}`,
      );
      await load();
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setRetryingId(null);
    }
  };

  const columns: DataTableColumn<AccountingEventRow>[] = [
    { key: "eventType", header: "نوع رویداد", render: (r) => EVENT_TYPE_LABELS[r.eventType] ?? r.eventType },
    {
      key: "status",
      header: "وضعیت",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_CLASSES[r.status] ?? ""}`}>
          {EVENT_STATUS_LABELS[r.status] ?? r.status}
        </span>
      ),
    },
    { key: "source", header: "مبدا", render: (r) => `${r.sourceEntityType}:${r.sourceEntityId.slice(0, 8)}` },
    {
      key: "journalEntry",
      header: "سند",
      render: (r) =>
        r.journalEntryId ? (
          <button
            type="button"
            className="text-teal-700 underline-offset-2 hover:underline"
            onClick={() => setDrillEntryId(r.journalEntryId!)}
          >
            مشاهده
          </button>
        ) : (
          "—"
        ),
    },
    {
      key: "error",
      header: "خطا",
      render: (r) => (
        <span className="block max-w-[220px] truncate text-xs text-rose-700" title={r.error ?? undefined}>
          {r.error ?? "—"}
        </span>
      ),
    },
    { key: "createdAt", header: "زمان", render: (r) => jalaliDateTime(r.createdAt) },
    {
      key: "actions",
      header: "",
      render: (r) =>
        r.status === "FAILED" ? (
          <Button
            variant="secondary"
            disabled={retryingId === r.id}
            onClick={() => void retry(r.id)}
          >
            {retryingId === r.id ? "در حال تلاش…" : "تلاش مجدد"}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <Button variant={tab === "events" ? "primary" : "secondary"} onClick={() => setTab("events")}>
          رویدادها
        </Button>
        <Button variant={tab === "rules" ? "primary" : "secondary"} onClick={() => setTab("rules")}>
          قواعد ثبت
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      {tab === "events" ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500">وضعیت</label>
              <select
                value={statusFilter}
                onChange={(e) => {
                  setPage(1);
                  setStatusFilter(e.target.value as "" | EventsQuery["status"]);
                }}
                className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
              >
                <option value="">همه</option>
                <option value="FAILED">ناموفق</option>
                <option value="SKIPPED">ردشده</option>
                <option value="POSTED">ثبت‌شده</option>
              </select>
            </div>
          </div>

          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r.id}
            loading={loading}
            emptyMessage="رویدادی با این فیلترها یافت نشد."
            dense
          />

          {total > pageSize && (
            <div className="flex items-center justify-center gap-3 text-sm">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                قبلی
              </Button>
              <span className="text-slate-500">
                صفحه {faDigits(page)} از {faDigits(Math.max(1, Math.ceil(total / pageSize)))}
              </span>
              <Button
                variant="secondary"
                disabled={page >= Math.ceil(total / pageSize)}
                onClick={() => setPage((p) => p + 1)}
              >
                بعدی
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className="space-y-3">
          {rules.length === 0 && !loading && (
            <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
              قاعده ثبتی تعریف نشده است.
            </div>
          )}
          {rules.map((rule) => (
            <div key={rule.id} className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-900">{rule.nameFa}</span>
                <span className="text-xs text-slate-400">{rule.code}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                  {EVENT_TYPE_LABELS[rule.eventType] ?? rule.eventType}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                    rule.enabled ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"
                  }`}
                >
                  {rule.enabled ? "فعال" : "غیرفعال"}
                </span>
              </div>
              <table className="mt-3 min-w-full text-right text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">سمت</th>
                    <th className="px-2 py-1 font-medium">حساب</th>
                    <th className="px-2 py-1 font-medium">سنجه</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rule.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="px-2 py-1">{l.side === "DEBIT" ? "بدهکار" : "بستانکار"}</td>
                      <td className="px-2 py-1">{l.accountCode}</td>
                      <td className="px-2 py-1">{l.measure}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      <JournalEntryModal
        entryId={drillEntryId}
        onClose={() => setDrillEntryId(null)}
        onNavigate={(id) => setDrillEntryId(id)}
      />
    </div>
  );
}
