"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, faMoneyExact, jalaliDateTime } from "@/lib/format";
import {
  accountingErrorMessage,
  fetchOpeningBalances,
  generateOpeningEntry,
  stageOpeningBalances,
  type OpeningBalanceEntry,
  type OpeningRowInput,
} from "@/lib/accounting";

const STATUS_LABELS: Record<string, string> = {
  STAGED: "ثبت موقت",
  POSTED: "سند صادر شده",
};

/** افتتاحیه — staged rows, then ONE balanced OPENING journal entry. */
export default function OpeningBalancesPage() {
  const [entries, setEntries] = useState<OpeningBalanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [staging, setStaging] = useState(false);
  const [generateDate, setGenerateDate] = useState<string | null>(null);

  // staged row editor state
  const [accountCode, setAccountCode] = useState("");
  const [debit, setDebit] = useState("");
  const [credit, setCredit] = useState("");
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await fetchOpeningBalances());
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addRow = async () => {
    setError(null);
    setNotice(null);
    if (!accountCode.trim() || (!debit.trim() && !credit.trim())) {
      setError("کد حساب و مبلغ بدهکار یا بستانکار الزامی است.");
      return;
    }
    const row: OpeningRowInput = {
      accountCode: accountCode.trim(),
      debit: debit.trim() || null,
      credit: credit.trim() || null,
      note: note.trim() || null,
    };
    setStaging(true);
    try {
      await stageOpeningBalances([row]);
      setAccountCode("");
      setDebit("");
      setCredit("");
      setNote("");
      setNotice("ردیف افتتاحیه ثبت موقت شد.");
      await load();
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setStaging(false);
    }
  };

  const generate = async () => {
    setError(null);
    setNotice(null);
    try {
      await generateOpeningEntry(generateDate ?? undefined);
      setNotice("سند افتتاحیه صادر شد.");
      await load();
    } catch (e) {
      setError(accountingErrorMessage(e));
    }
  };

  const columns: DataTableColumn<OpeningBalanceEntry>[] = [
    { key: "accountCode", header: "کد حساب", render: (r) => r.accountCode },
    { key: "partyName", header: "طرف حساب", render: (r) => r.partyName ?? "—" },
    { key: "debit", header: "بدهکار", render: (r) => faMoneyExact(r.debit === "0" ? null : r.debit) },
    { key: "credit", header: "بستانکار", render: (r) => faMoneyExact(r.credit === "0" ? null : r.credit) },
    {
      key: "status",
      header: "وضعیت",
      render: (r) => (
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            r.status === "POSTED" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"
          }`}
        >
          {STATUS_LABELS[r.status] ?? r.status}
        </span>
      ),
    },
    { key: "createdAt", header: "زمان ثبت", render: (r) => jalaliDateTime(r.createdAt) },
  ];

  const staged = entries.filter((e) => e.status === "STAGED");
  // exact comparison at scale 4 (Decimal(20,4)) — no float conversion
  const scaled4 = (s: string) => {
    const [i, f = ""] = s.split(".");
    return BigInt(i + (f + "0000").slice(0, 4));
  };
  const stagedDebit = staged.reduce((acc, e) => acc + scaled4(e.debit), BigInt(0));
  const stagedCredit = staged.reduce((acc, e) => acc + scaled4(e.credit), BigInt(0));

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">ثبت ردیف افتتاحیه</h3>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">کد حساب</label>
            <Input value={accountCode} onChange={(e) => setAccountCode(e.target.value)} className="w-40" />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">بدهکار</label>
            <Input
              value={debit}
              onChange={(e) => setDebit(e.target.value)}
              className="w-40 tabular-nums"
              placeholder="0"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">بستانکار</label>
            <Input
              value={credit}
              onChange={(e) => setCredit(e.target.value)}
              className="w-40 tabular-nums"
              placeholder="0"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">توضیح</label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} className="w-52" />
          </div>
          <Button onClick={() => void addRow()} disabled={staging}>
            افزودن ردیف
          </Button>
        </div>
        {staged.length > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            جمع موقت: بدهکار {faMoneyExact(stagedDebit.toString())} / بستانکار{" "}
            {faMoneyExact(stagedCredit.toString())}{" "}
            {stagedDebit === stagedCredit ? (
              <span className="font-medium text-emerald-700">(متوازن)</span>
            ) : (
              <span className="font-medium text-rose-700">(نامتوازن)</span>
            )}
          </p>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">صدای سند افتتاحیه</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          از ردیف‌های ثبت‌شده یک سند افتتاحیه متوازن صادر می‌شود. این عملیات در صورت نامتوازن بودن ردیف‌ها رد می‌شود.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div>
            <span className="mb-1 block text-xs text-slate-500">تاریخ سند</span>
            <JalaliDateInput value={generateDate} onChange={setGenerateDate} />
          </div>
          <Button onClick={() => void generate()} disabled={entries.length === 0}>
            صدای سند افتتاحیه
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={entries}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="ردیفی برای افتتاحیه ثبت نشده است."
        dense
      />
    </div>
  );
}
