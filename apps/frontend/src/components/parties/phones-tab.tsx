"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits, normalizeMobile } from "@/lib/format";
import {
  PHONE_KINDS,
  PHONE_KIND_LABELS,
  addPartyPhone,
  deletePartyPhone,
  partyErrorMessage,
  type PartyDetail,
  type PhoneKind,
} from "@/lib/party";

interface PhonesTabProps {
  party: PartyDetail;
  onChanged: (party: PartyDetail) => void;
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 ${filled ? "text-amber-500" : "text-slate-300"}`}
      aria-hidden="true"
    >
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}

export function PhonesTab({ party, onChanged }: PhonesTabProps) {
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<PhoneKind>("MOBILE");
  const [value, setValue] = useState("");
  const [isPrimary, setIsPrimary] = useState(party.phones.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEscClose(adding, () => {
    setAdding(false);
    addTriggerRef.current?.focus();
  }, addTriggerRef);

  async function handleAdd() {
    if (busy) return;
    if (!value.trim()) {
      setError("شماره را وارد کنید.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await addPartyPhone(party.id, {
        kind,
        value: kind === "MOBILE" ? normalizeMobile(value) : value.trim(),
        isPrimary,
      });
      setAdding(false);
      setValue("");
      setIsPrimary(false);
      setKind("MOBILE");
      addTriggerRef.current?.focus();
      onChanged(updated);
    } catch (err) {
      setError(partyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(phoneId: string) {
    setError(null);
    try {
      await deletePartyPhone(party.id, phoneId);
      onChanged({ ...party, phones: party.phones.filter((phone) => phone.id !== phoneId) });
    } catch (err) {
      setError(partyErrorMessage(err));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">تلفن‌ها</h3>
        {!adding && (
          <Button ref={addTriggerRef} variant="secondary" size="sm" onClick={() => setAdding(true)}>
            افزودن تلفن
          </Button>
        )}
      </div>

      {adding && (
        <div
          className="mb-4 rounded-lg border border-primary-200 bg-primary-50/50 p-3"
          role="group"
          aria-label="افزودن تلفن جدید"
        >
          <div className="flex flex-wrap items-start gap-2">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PhoneKind)}
              aria-label="نوع تلفن"
              className="h-10 w-28 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              {PHONE_KINDS.map((item) => (
                <option key={item} value={item}>
                  {PHONE_KIND_LABELS[item]}
                </option>
              ))}
            </select>
            <div className="min-w-48 flex-1">
              <Input
                dir="ltr"
                autoFocus
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleAdd();
                  }
                }}
                aria-label="شماره تلفن"
                placeholder={kind === "MOBILE" ? "۰۹۱۲…" : "021-…"}
                autoComplete="off"
              />
              {kind === "MOBILE" && value.trim() && (
                <p className="mt-1 text-[11px] text-slate-400" dir="ltr">
                  {faDigits(normalizeMobile(value))}
                </p>
              )}
            </div>
            <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isPrimary}
                onChange={(e) => setIsPrimary(e.target.checked)}
                className="h-4 w-4 accent-primary-600"
              />
              اصلی
            </label>
            <Button size="md" onClick={handleAdd} disabled={busy}>
              {busy ? "…" : "افزودن"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAdding(false);
                addTriggerRef.current?.focus();
              }}
              disabled={busy}
            >
              انصراف
            </Button>
          </div>
          {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
        </div>
      )}

      {error && !adding && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {party.phones.length === 0 && !adding ? (
        <p className="py-6 text-center text-sm text-slate-400">تلفنی ثبت نشده است.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {party.phones.map((phone) => {
            const display = phone.rawValue ?? phone.value ?? phone.normalizedValue ?? "—";
            return (
              <li key={phone.id ?? display} className="flex items-center justify-between gap-3 py-2.5">
                <div className="flex items-center gap-2">
                  <StarIcon filled={Boolean(phone.isPrimary)} />
                  <span className="text-sm font-medium text-slate-800" dir="ltr">
                    {faDigits(display)}
                  </span>
                  <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500">
                    {PHONE_KIND_LABELS[phone.kind] ?? phone.kind}
                  </span>
                  {phone.isPrimary && (
                    <span className="text-[11px] font-medium text-amber-600">اصلی</span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => phone.id && handleDelete(phone.id)}
                  disabled={!phone.id}
                  aria-label={`حذف شماره ${display}`}
                  className="text-red-500 hover:bg-red-50"
                >
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                  </svg>
                  حذف
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
