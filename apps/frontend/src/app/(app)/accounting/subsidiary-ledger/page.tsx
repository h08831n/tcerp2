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
  fetchPartyBalances,
  fetchPartyLedger,
  type LedgerRow,
  type PartyBalanceRow,
} from "@/lib/accounting";

type View =
  | { role: "CUSTOMER" | "SUPPLIER" }
  | { partyId: string; nameFa: string; role: "CUSTOMER" | "SUPPLIER" };

/** Ledger account per role: customers post to RECEIVABLE, suppliers to PAYABLE
 *  (the backend default is RECEIVABLE — drill-down must state it explicitly). */
const LEDGER_ACCOUNT: Record<"CUSTOMER" | "SUPPLIER", string> = {
  CUSTOMER: "RECEIVABLE",
  SUPPLIER: "PAYABLE",
};

/** دفتر معین — party balances list, drill into each party's ledger rows. */

/** Exact decimal-string subtraction at scale 4 (never touches a JS float). */
function subtractExact(a: string, b: string): string {
  const scaled = (s: string) => {
    const neg = s.startsWith("-");
    const digits = neg ? s.slice(1) : s;
    const [i, f = ""] = digits.split(".");
    return BigInt((neg ? "-" : "") + i + (f + "0000").slice(0, 4));
  };
  const diff = scaled(a) - scaled(b);
  const negative = diff < BigInt(0);
  const abs = (negative ? -diff : diff).toString().padStart(5, "0");
  const intPart = abs.slice(0, -4) || "0";
  const fracPart = abs.slice(-4).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${fracPart ? "." + fracPart : ""}`;
}
export default function SubsidiaryLedgerPage() {
  const [view, setView] = useState<View>({ role: "CUSTOMER" });
  const [search, setSearch] = useState("");
  const [balances, setBalances] = useState<PartyBalanceRow[]>([]);
  const [balanceTotal, setBalanceTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[] | null>(null);
  const [partyName, setPartyName] = useState("");
  const [from, setFrom] = useState<string | null>(null);
  const [to, setTo] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [drillEntryId, setDrillEntryId] = useState<string | null>(null);
  const pageSize = 25;

  const loadBalances = useCallback(async () => {
    if ("partyId" in view) return; // balances view needs the role variant
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPartyBalances({
        role: view.role,
        search: search || undefined,
        page,
        pageSize,
      });
      setBalances(res.items);
      setBalanceTotal(res.total);
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [view, search, page]);

  const loadLedger = useCallback(async () => {
    if (!("partyId" in view)) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetchPartyLedger(view.partyId, {
        accountCode: LEDGER_ACCOUNT[view.role],
        from: from ?? undefined,
        to: to ?? undefined,
      });
      setLedgerRows(res.rows);
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [view, from, to]);

  useEffect(() => {
    if (!("partyId" in view)) void loadBalances();
    else void loadLedger();
  }, [view, loadBalances, loadLedger]);

  const balanceColumns: DataTableColumn<PartyBalanceRow>[] = [
    { key: "nameFa", header: "نام", render: (r) => r.nameFa },
    {
      key: "debit",
      header: "بدهکار",
      render: (r) => faMoneyExact(r.debit && r.debit !== "0" ? r.debit : null),
    },
    {
      key: "credit",
      header: "بستانکار",
      render: (r) => faMoneyExact(r.credit && r.credit !== "0" ? r.credit : null),
    },
    {
      key: "balance",
      header: "مانده",
      render: (r) => faMoneyExact(r.debit && r.credit ? subtractExact(r.debit, r.credit) : null),
    },
    { key: "lastActivity", header: "آخرین گردش", render: (r) => (r.lastActivity ? jalali(r.lastActivity) : "—") },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <Button variant="secondary" onClick={() => setView({ partyId: r.partyId, nameFa: r.nameFa, role: view.role })}>
          گردش حساب
        </Button>
      ),
    },
  ];

  const ledgerColumns: DataTableColumn<LedgerRow>[] = [
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
      {"partyId" in view ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <button
                type="button"
                className="text-sm text-teal-700 underline-offset-2 hover:underline"
                onClick={() => setView({ role: view.role })}
              >
                ← بازگشت به فهرست مانده‌ها
              </button>
              <h3 className="mt-1 text-sm font-semibold text-slate-900">دفتر معین: {view.nameFa}</h3>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <span className="mb-1 block text-xs text-slate-500">از تاریخ</span>
                <JalaliDateInput value={from} onChange={setFrom} />
              </div>
              <div>
                <span className="mb-1 block text-xs text-slate-500">تا تاریخ</span>
                <JalaliDateInput value={to} onChange={setTo} />
              </div>
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
          )}

          <DataTable
            columns={ledgerColumns}
            rows={ledgerRows ?? []}
            rowKey={(r) => r.entryId + ":" + r.debit + ":" + r.credit}
            loading={loading}
            emptyMessage="گردشی برای این حساب در بازه انتخابی ثبت نشده است."
            dense
          />

          <JournalEntryModal
            entryId={drillEntryId}
            onClose={() => setDrillEntryId(null)}
            onNavigate={(id) => setDrillEntryId(id)}
          />
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500">نوع حساب</label>
              <select
                value={view.role}
                onChange={(e) => {
                  setPage(1);
                  setView({ role: e.target.value as "CUSTOMER" | "SUPPLIER" });
                }}
                className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
              >
                <option value="CUSTOMER">مشتریان (دریافتنی)</option>
                <option value="SUPPLIER">تامین‌کنندگان (پرداختنی)</option>
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs text-slate-500">جستجو</label>
              <Input
                value={search}
                onChange={(e) => {
                  setPage(1);
                  setSearch(e.target.value);
                }}
                placeholder="نام مشتری/تامین‌کننده"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
          )}

          <DataTable
            columns={balanceColumns}
            rows={balances}
            rowKey={(r) => r.partyId}
            loading={loading}
            emptyMessage="هیچ حساب معینی با گردش یافت نشد."
            dense
          />

          {balanceTotal > pageSize && (
            <div className="flex items-center justify-center gap-3 text-sm">
              <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                قبلی
              </Button>
              <span className="text-slate-500">
                صفحه {faDigits(page)} از {faDigits(Math.max(1, Math.ceil(balanceTotal / pageSize)))}
              </span>
              <Button
                variant="secondary"
                disabled={page >= Math.ceil(balanceTotal / pageSize)}
                onClick={() => setPage((p) => p + 1)}
              >
                بعدی
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
