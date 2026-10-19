"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, faMoneyExact } from "@/lib/format";
import {
  accountingErrorMessage,
  fetchFiscalYears,
  fetchTrialBalance,
  type FiscalYear,
  type TrialBalanceReport,
  type TrialBalanceRow,
} from "@/lib/accounting";

/** تراز آزمایشی — opening / period / closing with a clear balanced status. */
export default function TrialBalancePage() {
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [fiscalYearId, setFiscalYearId] = useState("");
  const [rows, setRows] = useState<TrialBalanceRow[]>([]);
  const [totals, setTotals] = useState<TrialBalanceReport["totals"] | null>(null);
  const [balanced, setBalanced] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchFiscalYears()
      .then(setYears)
      .catch(() => setYears([])); // fiscal dropdown is optional chrome
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const report = await fetchTrialBalance({
        from: from ?? undefined,
        to: to ?? undefined,
        fiscalYearId: fiscalYearId || undefined,
      });
      setRows(report.rows);
      setTotals(report.totals);
      setBalanced(report.balanced);
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [from, to, fiscalYearId]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<TrialBalanceRow>[] = [
    {
      key: "account",
      header: "حساب",
      render: (r) => (
        <div className={r.level === "parent" ? "font-semibold text-slate-900" : "text-slate-700"}>
          <span className="me-2 text-xs text-slate-400">{r.accountCode}</span>
          {r.accountName}
        </div>
      ),
    },
    { key: "openingDebit", header: "افتتاحیه بدهکار", render: (r) => faMoneyExact(r.openingDebit === "0" ? null : r.openingDebit) },
    { key: "openingCredit", header: "افتتاحیه بستانکار", render: (r) => faMoneyExact(r.openingCredit === "0" ? null : r.openingCredit) },
    { key: "debit", header: "گردش بدهکار", render: (r) => faMoneyExact(r.debit === "0" ? null : r.debit) },
    { key: "credit", header: "گردش بستانکار", render: (r) => faMoneyExact(r.credit === "0" ? null : r.credit) },
    { key: "closingDebit", header: "مانده بدهکار", render: (r) => faMoneyExact(r.closingDebit === "0" ? null : r.closingDebit) },
    { key: "closingCredit", header: "مانده بستانکار", render: (r) => faMoneyExact(r.closingCredit === "0" ? null : r.closingCredit) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">سال مالی</label>
          <select
            value={fiscalYearId}
            onChange={(e) => setFiscalYearId(e.target.value)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            <option value="">همه بازه‌ها</option>
            {years.map((y) => (
              <option key={y.id} value={y.id}>
                {faDigits(y.code)} — {y.nameFa}
              </option>
            ))}
          </select>
        </div>
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

      {balanced !== null && (
        <div
          className={`rounded-lg border p-3 text-sm font-medium ${
            balanced
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          {balanced
            ? "تراز آزمایشی متوازن است — جمع بدهکار و بستانکار برابر است."
            : "هشدار: تراز آزمایشی متوازن نیست!"}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {totals && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">جمع گردش بدهکار</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.debit)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">جمع گردش بستانکار</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.credit)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">جمع مانده بدهکار</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.closingDebit)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-3">
            <div className="text-xs text-slate-500">جمع مانده بستانکار</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.closingCredit)}</div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.accountId}
        loading={loading}
        emptyMessage="سطری برای تراز آزمایشی یافت نشد."
        dense
      />
    </div>
  );
}
