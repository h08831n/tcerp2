"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { jalaliDateTime } from "@/lib/format";
import { faMoneyExact } from "@/lib/format";
import {
  accountingErrorMessage,
  fetchJournalEntry,
  type JournalEntryDetail,
} from "@/lib/accounting";

const STATUS_LABELS: Record<JournalEntryDetail["status"], string> = {
  DRAFT: "پیش‌نویس",
  POSTED: "ثبت‌شده",
  REVERSED: "برگشت‌خورده",
  CANCELLED: "لغوشده",
};

const STATUS_CLASSES: Record<JournalEntryDetail["status"], string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  POSTED: "bg-emerald-100 text-emerald-800",
  REVERSED: "bg-amber-100 text-amber-800",
  CANCELLED: "bg-rose-100 text-rose-800",
};

/** Report-row drill-down: fetches one journal entry read-only (Phase 7D). */
export function JournalEntryModal({
  entryId,
  onClose,
  onNavigate,
}: {
  entryId: string | null;
  onClose: () => void;
  /** navigate the modal to another entry (reversal links) */
  onNavigate?: (entryId: string) => void;
}) {
  const [entry, setEntry] = useState<JournalEntryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    setEntry(null);
    try {
      setEntry(await fetchJournalEntry(id));
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (entryId) void load(entryId);
  }, [entryId, load]);

  return (
    <Modal open={!!entryId} title="جزئیات سند حسابداری" onClose={onClose}>
      {loading && <div className="p-4 text-sm text-slate-500">در حال بارگذاری…</div>}
      {!loading && error && <div className="p-4 text-sm text-rose-600">{error}</div>}
      {!loading && entry && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <span className="text-slate-500">شماره سند: </span>
              <span className="font-medium">{entry.entryNumber}</span>
            </div>
            <div>
              <span className="text-slate-500">تاریخ: </span>
              <span>{jalaliDateTime(entry.entryDate)}</span>
            </div>
            <div>
              <span className="text-slate-500">دفتر: </span>
              <span>{entry.journalCode}</span>
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_CLASSES[entry.status]}`}>
              {STATUS_LABELS[entry.status]}
            </span>
          </div>

          {(entry.reversalOf || entry.reversedBy) && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-900">
              <div>
                رابطه برگشت:
                {entry.reversalOf && (
                  <>
                    {" "}این سند برگشتِ سند{" "}
                    {onNavigate ? (
                      <button
                        type="button"
                        className="font-medium underline"
                        onClick={() => onNavigate(entry.reversalOf!.id)}
                      >
                        {entry.reversalOf.entryNumber}
                      </button>
                    ) : (
                      <span className="font-medium">{entry.reversalOf.entryNumber}</span>
                    )}
                  </>
                )}
                {entry.reversedBy && (
                  <>
                    {" "}این سند با سند{" "}
                    {onNavigate ? (
                      <button
                        type="button"
                        className="font-medium underline"
                        onClick={() => onNavigate(entry.reversedBy!.id)}
                      >
                        {entry.reversedBy.entryNumber}
                      </button>
                    ) : (
                      <span className="font-medium">{entry.reversedBy.entryNumber}</span>
                    )}
                    {" "}برگشت خورده است
                  </>
                )}
                .
              </div>
            </div>
          )}

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-right">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">حساب</th>
                  <th className="px-3 py-2 font-medium">شرح</th>
                  <th className="px-3 py-2 font-medium">طرف حساب</th>
                  <th className="px-3 py-2 font-medium">بدهکار</th>
                  <th className="px-3 py-2 font-medium">بستانکار</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {entry.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2">
                      <div className="font-medium text-slate-800">{l.accountName}</div>
                      <div className="text-xs text-slate-400">{l.accountCode}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{l.description ?? "—"}</td>
                    <td className="px-3 py-2 text-slate-600">{l.partyNameFa ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {l.debit === "0" ? "—" : faMoneyExact(l.debit)}
                    </td>
                    <td className="px-3 py-2 tabular-nums">
                      {l.credit === "0" ? "—" : faMoneyExact(l.credit)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
