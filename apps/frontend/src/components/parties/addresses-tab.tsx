"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits } from "@/lib/format";
import {
  ADDRESS_TYPE_LABELS,
  addPartyAddress,
  deletePartyAddress,
  partyErrorMessage,
  type PartyDetail,
} from "@/lib/party";

interface AddressesTabProps {
  party: PartyDetail;
  onChanged: (party: PartyDetail) => void;
}

const ADDRESS_TYPES = ["MAIN", "BILLING", "SHIPPING", "WAREHOUSE", "OTHER"];

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

export function AddressesTab({ party, onChanged }: AddressesTabProps) {
  const [adding, setAdding] = useState(false);
  const [type, setType] = useState("MAIN");
  const [province, setProvince] = useState("");
  const [city, setCity] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [line, setLine] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEscClose(adding, () => {
    setAdding(false);
    addTriggerRef.current?.focus();
  }, addTriggerRef);

  function resetForm() {
    setType("MAIN");
    setProvince("");
    setCity("");
    setPostalCode("");
    setLine("");
    setIsPrimary(false);
  }

  async function handleAdd() {
    if (busy) return;
    if (!line.trim()) {
      setError("نشانی الزامی است.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await addPartyAddress(party.id, {
        type,
        province: province.trim() || undefined,
        city: city.trim() || undefined,
        postalCode: postalCode.trim() || undefined,
        line: line.trim(),
        isPrimary,
      });
      setAdding(false);
      resetForm();
      addTriggerRef.current?.focus();
      onChanged(updated);
    } catch (err) {
      setError(partyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(addressId: string) {
    setError(null);
    try {
      await deletePartyAddress(party.id, addressId);
      onChanged({
        ...party,
        addresses: party.addresses.filter((address) => address.id !== addressId),
      });
    } catch (err) {
      setError(partyErrorMessage(err));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">آدرس‌ها</h3>
        {!adding && (
          <Button ref={addTriggerRef} variant="secondary" size="sm" onClick={() => setAdding(true)}>
            افزودن آدرس
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-4 rounded-lg border border-primary-200 bg-primary-50/50 p-3" role="group" aria-label="افزودن آدرس">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="a-type" className={fieldLabel}>نوع</label>
              <select
                id="a-type"
                autoFocus
                value={type}
                onChange={(e) => setType(e.target.value)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                {ADDRESS_TYPES.map((item) => (
                  <option key={item} value={item}>{ADDRESS_TYPE_LABELS[item] ?? item}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="a-province" className={fieldLabel}>استان</label>
              <Input id="a-province" className="text-sm" value={province}
                onChange={(e) => setProvince(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="a-city" className={fieldLabel}>شهر</label>
              <Input id="a-city" className="text-sm" value={city}
                onChange={(e) => setCity(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="a-postal" className={fieldLabel}>کد پستی</label>
              <Input id="a-postal" className="text-sm" dir="ltr" value={postalCode}
                onChange={(e) => setPostalCode(e.target.value)} autoComplete="off" />
            </div>
          </div>
          <div className="mt-3">
            <label htmlFor="a-line" className={fieldLabel}>نشانی *</label>
            <textarea
              id="a-line"
              rows={2}
              value={line}
              onChange={(e) => setLine(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" checked={isPrimary}
                onChange={(e) => setIsPrimary(e.target.checked)}
                className="h-4 w-4 accent-primary-600" />
              آدرس اصلی
            </label>
            <Button size="sm" onClick={handleAdd} disabled={busy}>
              {busy ? "…" : "افزودن"}
            </Button>
            <Button variant="secondary" size="sm"
              onClick={() => {
                setAdding(false);
                addTriggerRef.current?.focus();
              }}
              disabled={busy}>
              انصراف
            </Button>
          </div>
        </div>
      )}

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {party.addresses.length === 0 && !adding ? (
        <p className="py-6 text-center text-sm text-slate-400">آدرسی ثبت نشده است.</p>
      ) : (
        <ul className="space-y-3">
          {party.addresses.map((address) => (
            <li key={address.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                      {ADDRESS_TYPE_LABELS[address.type] ?? address.type}
                    </span>
                    {address.isPrimary && (
                      <span className="rounded border border-primary-200 bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">
                        اصلی
                      </span>
                    )}
                    {address.province && (
                      <span className="text-xs text-slate-500">
                        استان {address.province}
                        {address.city ? `، ${address.city}` : ""}
                      </span>
                    )}
                    {address.postalCode && (
                      <span className="text-xs text-slate-400" dir="ltr">
                        {faDigits(address.postalCode)}
                      </span>
                    )}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">{address.line}</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(address.id)}
                  aria-label="حذف آدرس"
                  className="text-red-500 hover:bg-red-50">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                    <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                  </svg>
                  حذف
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
