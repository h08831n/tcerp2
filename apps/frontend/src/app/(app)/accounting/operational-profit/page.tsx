"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { JournalEntryModal } from "@/components/accounting/journal-entry-modal";
import { faDigits, faMoneyExact, jalali } from "@/lib/format";
import {
  accountingErrorMessage,
  fetchOperationalProfit,
  type ProfitRow,
} from "@/lib/accounting";

const EVENT_TYPE_LABELS: Record<string, string> = {
  SALES_COMPLETED_LOADING: "شناسایی فروش (بارگیری)",
  INVENTORY_REVERSAL: "برگشت موجودی",
};

/** گزارش سود عملیاتی — event-snapshot based (originals + negated reversals). */
export default function OperationalProfitPage() {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [rows, setRows] = useState<ProfitRow[]>([]);
  const [totals, setTotals] = useState<{ revenue: string; cogs: string; grossProfit: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drillEntryId, setDrillEntryId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const report = await fetchOperationalProfit({ from: from ?? undefined, to: to ?? undefined });
      setRows(report.rows);
      setTotals(report.totals);
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<ProfitRow>[] = [
    {
      key: "entry",
      header: "سند",
      render: (r) => (
        <button
          type="button"
          className="text-teal-700 underline-offset-2 hover:underline"
          onClick={() => setDrillEntryId(r.journalEntryId)}
        >
          مشاهده
        </button>
      ),
    },
    { key: "entryDate", header: "تاریخ", render: (r) => jalali(r.entryDate) },
    {
      key: "eventType",
      header: "نوع رویداد",
      render: (r) => EVENT_TYPE_LABELS[r.eventType] ?? r.eventType,
    },
    { key: "customer", header: "مشتری", render: (r) => r.customerName ?? "—" },
    { key: "variant", header: "کالا", render: (r) => (r.productVariantId ? r.productVariantId.slice(0, 8) : "—") },
    { key: "revenue", header: "درآمد", render: (r) => faMoneyExact(r.revenue) },
    { key: "cogs", header: "بهای تمام‌شده", render: (r) => faMoneyExact(r.cogs) },
    { key: "grossProfit", header: "سود ناخالص", render: (r) => faMoneyExact(r.grossProfit) },
    {
      key: "marginPct",
      header: "حاشیه سود",
      render: (r) => (r.marginPct ? `${faDigits(r.marginPct)}٪` : "—"),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="mb-1 block text-xs text-slate-500">از تاریخ</span>
          <JalaliDateInput value={from} onChange={setFrom} />
        </div>
        <div>
          <span className="mb-1 block text-xs text-slate-500">تا تاریخ</span>
          <JalaliDateInput value={to} onChange={setTo} />
        </div>
        <Button onClick={() => void load()} disabled={loading}>
          نمایش
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {totals && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">جمع درآمد</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.revenue)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">جمع بهای تمام‌شده</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.cogs)}</div>
          </div>
          <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
            <div className="text-xs text-teal-700">سود ناخالص</div>
            <div className="mt-1 text-sm font-semibold tabular-nums text-teal-900">
              {faMoneyExact(totals.grossProfit)}
            </div>
          </div>
        </div>
      )}

      <p className="text-xs leading-5 text-slate-500">
        مبنا: رویدادهای عملیاتی ثبت‌شده در لحظه بارگیری. رویدادهای برگشت با علامت منفی لحاظ می‌شوند؛ مانده گزارش با
        اسناد حسابداری مرتبط قابل ردیابی است.
      </p>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.eventId}
        loading={loading}
        emptyMessage="رویداد عملیاتی در بازه انتخابی ثبت نشده است."
        dense
      />

      <JournalEntryModal
        entryId={drillEntryId}
        onClose={() => setDrillEntryId(null)}
        onNavigate={(id) => setDrillEntryId(id)}
      />
    </div>
  );
}
