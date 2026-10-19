"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { JournalEntryModal } from "@/components/accounting/journal-entry-modal";
import { faDigits, faMoneyExact, jalali } from "@/lib/format";
import {
  accountingErrorMessage,
  fetchGeneralLedger,
  type LedgerRow,
} from "@/lib/accounting";

/** دفتر کل — keyset-paginated, reversal-inclusive (both sides shown). */
export default function GeneralLedgerPage() {
  const [accountCode, setAccountCode] = useState("BANK");
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [openingBalance, setOpeningBalance] = useState<string>("0");
  const [totals, setTotals] = useState<{ debit: string; credit: string; closingBalance: string } | null>(null);
  const [accountName, setAccountName] = useState("");
  const [normalSide, setNormalSide] = useState<"DEBIT" | "CREDIT">("DEBIT");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drillEntryId, setDrillEntryId] = useState<string | null>(null);

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const report = await fetchGeneralLedger({
          accountCode,
          from: from ?? undefined,
          to: to ?? undefined,
          limit: 50,
          cursor,
        });
        setRows((prev) => (cursor ? [...prev, ...report.rows] : report.rows));
        if (!cursor) {
          setOpeningBalance(report.openingBalance);
          setTotals(report.totals);
          setAccountName(report.accountName);
          setNormalSide(report.normalSide);
        }
        setNextCursor(report.nextCursor);
      } catch (e) {
        setError(accountingErrorMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [accountCode, from, to],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  const columns: DataTableColumn<LedgerRow>[] = [
    {
      key: "entry",
      header: "سند",
      render: (r) => (
        <button
          type="button"
          className="text-teal-700 underline-offset-2 hover:underline"
          onClick={() => setDrillEntryId(r.entryId)}
        >
          {r.entryNumber}
        </button>
      ),
    },
    { key: "entryDate", header: "تاریخ", render: (r) => jalali(r.entryDate) },
    { key: "journalCode", header: "دفتر", render: (r) => r.journalCode },
    {
      key: "description",
      header: "شرح",
      render: (r) => (
        <div className="flex items-center gap-2">
          <span>{r.description ?? "—"}</span>
          {r.reversed && (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
              برگشت
            </span>
          )}
        </div>
      ),
    },
    { key: "debit", header: "بدهکار", render: (r) => faMoneyExact(r.debit === "0" ? null : r.debit) },
    { key: "credit", header: "بستانکار", render: (r) => faMoneyExact(r.credit === "0" ? null : r.credit) },
    { key: "runningBalance", header: "مانده", render: (r) => faMoneyExact(r.runningBalance) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">کد حساب</label>
          <Input
            value={accountCode}
            onChange={(e) => setAccountCode(e.target.value)}
            placeholder="مثلاً BANK یا RECEIVABLE"
            className="w-44"
          />
        </div>
        <div>
          <span className="mb-1 block text-xs text-slate-500">از تاریخ</span>
          <JalaliDateInput value={from} onChange={setFrom} />
        </div>
        <div>
          <span className="mb-1 block text-xs text-slate-500">تا تاریخ</span>
          <JalaliDateInput value={to} onChange={setTo} />
        </div>
        <Button onClick={() => void load(null)} disabled={loading}>
          نمایش
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {totals && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">مانده افتتاحیه ({faDigits(accountName || accountCode)})</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(openingBalance)}</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">جمع گردش (بدهکار / بستانکار)</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">
              {faMoneyExact(totals.debit)} / {faMoneyExact(totals.credit)}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">
              مانده پایانی (طبیعت: {normalSide === "DEBIT" ? "بدهکار" : "بستانکار"})
            </div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(totals.closingBalance)}</div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.entryId + ":" + r.debit + ":" + r.credit}
        loading={loading}
        emptyMessage="گردشی برای این حساب در بازه انتخابی ثبت نشده است."
      />

      {nextCursor && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => void load(nextCursor)} disabled={loading}>
            نمایش بیشتر
          </Button>
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
