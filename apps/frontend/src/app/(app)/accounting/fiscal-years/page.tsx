"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { enDigits, faDigits, jalali } from "@/lib/format";
import {
  accountingErrorMessage,
  closeFiscalYear,
  createFiscalYear,
  fetchFiscalYears,
  reopenFiscalYear,
  setFiscalPeriodStatus,
  type FiscalYear,
} from "@/lib/accounting";

type Confirm =
  | { kind: "closeYear"; year: FiscalYear }
  | { kind: "reopenYear"; year: FiscalYear }
  | { kind: "closePeriod"; year: FiscalYear; periodId: string; periodCode: string }
  | { kind: "reopenPeriod"; year: FiscalYear; periodId: string; periodCode: string }
  | null;

const YEAR_STATUS: Record<string, { label: string; classes: string }> = {
  OPEN: { label: "باز", classes: "bg-emerald-100 text-emerald-800" },
  CLOSED: { label: "بسته", classes: "bg-rose-100 text-rose-800" },
};

/** سال مالی — years with monthly periods; explicit confirm on every close/reopen. */
export default function FiscalYearsPage() {
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newNameFa, setNewNameFa] = useState("");
  const [newStart, setNewStart] = useState<string | null>(null);
  const [newEnd, setNewEnd] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const createYear = async () => {
    setError(null);
    setNotice(null);
    if (!newCode.trim() || !newNameFa.trim() || !newStart || !newEnd) {
      setError("کد، نام و هر دو تاریخ الزامی است.");
      return;
    }
    setCreating(true);
    try {
      await createFiscalYear({
        code: newCode.trim(),
        nameFa: newNameFa.trim(),
        startDate: newStart,
        endDate: newEnd,
      });
      setCreateOpen(false);
      setNewCode("");
      setNewNameFa("");
      setNewStart(null);
      setNewEnd(null);
      setNotice("سال مالی جدید با دوره‌های ماهانه ساخته شد.");
      await load();
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setYears(await fetchFiscalYears());
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runConfirm = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      switch (confirm.kind) {
        case "closeYear":
          await closeFiscalYear(confirm.year.id);
          setNotice(`سال مالی ${confirm.year.code} بسته شد.`);
          break;
        case "reopenYear":
          await reopenFiscalYear(confirm.year.id);
          setNotice(`سال مالی ${confirm.year.code} بازگشایی شد (دوره‌ها بسته می‌مانند).`);
          break;
        case "closePeriod":
          await setFiscalPeriodStatus(confirm.year.id, confirm.periodId, "CLOSED");
          setNotice(`دوره ${confirm.periodCode} بسته شد.`);
          break;
        case "reopenPeriod":
          await setFiscalPeriodStatus(confirm.year.id, confirm.periodId, "OPEN");
          setNotice(`دوره ${confirm.periodCode} بازگشایی شد.`);
          break;
      }
      setConfirm(null);
      await load();
    } catch (e) {
      setError(accountingErrorMessage(e));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  const confirmText = (() => {
    if (!confirm) return "";
    if (confirm.kind === "closeYear")
      return `با بستن سال مالی ${confirm.year.code} همه دوره‌های آن بسته می‌شوند و ثبت سند در این سال غیرممکن می‌شود. ادامه می‌دهید؟`;
    if (confirm.kind === "reopenYear")
      return `بازگشایی سال مالی ${confirm.year.code} فقط وضعیت خود سال را باز می‌کند؛ دوره‌های بسته بسته می‌مانند و باید هر دوره جداگانه بازگشایی شود. ادامه می‌دهید؟`;
    if (confirm.kind === "closePeriod")
      return `بستن دوره ${confirm.periodCode} مانع ثبت سند در بازه آن می‌شود. ادامه می‌دهید؟`;
    return `بازگشایی دوره ${confirm.periodCode} امکان ثبت سند در آن بازه را برمی‌گرداند. ادامه می‌دهید؟`;
  })();

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

      <p className="text-xs leading-5 text-slate-500">
        ثبت سند در دوره بسته یا سال بسته توسط سرور مسدود می‌شود. بستن سال، همه دوره‌های آن را می‌بندد؛ بازگشایی سال
        دوره‌ها را باز نمی‌کند و هر دوره باید صریحاً بازگشایی شود.
      </p>

      <div className="flex justify-end">
        <Button onClick={() => setCreateOpen(true)}>سال مالی جدید</Button>
      </div>

      {loading ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
          در حال بارگذاری…
        </div>
      ) : (
        years.map((year) => {
          const badge = YEAR_STATUS[year.status] ?? YEAR_STATUS.OPEN;
          const expanded = openId === year.id;
          return (
            <div key={year.id} className="rounded-lg border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-900">
                      {faDigits(year.code)} — {year.nameFa}
                    </span>
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${badge.classes}`}>
                      {badge.label}
                    </span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">
                    از {jalali(year.startDate)} تا {jalali(year.endDate)} — {faDigits(year.periods.length)} دوره
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {year.status === "OPEN" ? (
                    <Button variant="danger" onClick={() => setConfirm({ kind: "closeYear", year })}>
                      بستن سال
                    </Button>
                  ) : (
                    <Button variant="secondary" onClick={() => setConfirm({ kind: "reopenYear", year })}>
                      بازگشایی سال
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setOpenId(expanded ? null : year.id)}>
                    {expanded ? "بستن دوره‌ها" : "نمایش دوره‌ها"}
                  </Button>
                </div>
              </div>

              {expanded && (
                <div className="border-t border-slate-100 p-4">
                  {year.periods.length === 0 ? (
                    <div className="text-xs text-slate-500">دوره‌ای برای این سال تعریف نشده است.</div>
                  ) : (
                    <table className="min-w-full text-right text-xs">
                      <thead className="text-slate-500">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">کد</th>
                          <th className="px-2 py-1.5 font-medium">نام</th>
                          <th className="px-2 py-1.5 font-medium">از</th>
                          <th className="px-2 py-1.5 font-medium">تا</th>
                          <th className="px-2 py-1.5 font-medium">وضعیت</th>
                          <th className="px-2 py-1.5 font-medium"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {year.periods.map((p) => (
                          <tr key={p.id}>
                            <td className="px-2 py-1.5">{faDigits(p.code)}</td>
                            <td className="px-2 py-1.5">{p.nameFa}</td>
                            <td className="px-2 py-1.5">{jalali(p.startDate)}</td>
                            <td className="px-2 py-1.5">{jalali(p.endDate)}</td>
                            <td className="px-2 py-1.5">
                              <span
                                className={`rounded-full px-2 py-0.5 font-medium ${
                                  p.status === "OPEN"
                                    ? "bg-emerald-100 text-emerald-800"
                                    : "bg-rose-100 text-rose-800"
                                }`}
                              >
                                {p.status === "OPEN" ? "باز" : "بسته"}
                              </span>
                            </td>
                            <td className="px-2 py-1.5">
                              {year.status === "OPEN" &&
                                (p.status === "OPEN" ? (
                                  <Button
                                    variant="secondary"
                                    onClick={() =>
                                      setConfirm({
                                        kind: "closePeriod",
                                        year,
                                        periodId: p.id,
                                        periodCode: p.nameFa,
                                      })
                                    }
                                  >
                                    بستن دوره
                                  </Button>
                                ) : (
                                  <Button
                                    variant="secondary"
                                    onClick={() =>
                                      setConfirm({
                                        kind: "reopenPeriod",
                                        year,
                                        periodId: p.id,
                                        periodCode: p.nameFa,
                                      })
                                    }
                                  >
                                    بازگشایی دوره
                                  </Button>
                                ))}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}

      <Modal
        open={createOpen}
        title="سال مالی جدید"
        onClose={() => setCreateOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              انصراف
            </Button>
            <Button onClick={() => void createYear()} disabled={creating}>
              ایجاد سال
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">کد (مثلاً ۱۴۰۶)</label>
            <Input value={newCode} onChange={(e) => setNewCode(enDigits(e.target.value))} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">نام</label>
            <Input value={newNameFa} onChange={(e) => setNewNameFa(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="mb-1 block text-xs text-slate-500">از تاریخ</span>
              <JalaliDateInput value={newStart} onChange={setNewStart} />
            </div>
            <div>
              <span className="mb-1 block text-xs text-slate-500">تا تاریخ</span>
              <JalaliDateInput value={newEnd} onChange={setNewEnd} />
            </div>
          </div>
          <p className="text-xs leading-5 text-slate-500">
            دوره‌های ماهانه به‌صورت خودکار از تاریخ شروع ساخته می‌شوند.
          </p>
        </div>
      </Modal>

      <Modal
        open={!!confirm}
        title="تأیید عملیات"
        onClose={() => setConfirm(null)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConfirm(null)} disabled={busy}>
              انصراف
            </Button>
            <Button
              variant={confirm?.kind === "closeYear" || confirm?.kind === "closePeriod" ? "danger" : "primary"}
              onClick={() => void runConfirm()}
              disabled={busy}
            >
              تأیید
            </Button>
          </div>
        }
      >
        <p className="text-sm leading-6 text-slate-700">{confirmText}</p>
      </Modal>
    </div>
  );
}
