"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useEscClose } from "@/components/parties/use-esc-close";
import {
  PHONE_KINDS,
  PHONE_KIND_LABELS,
  addPartyContact,
  deletePartyContact,
  partyErrorMessage,
  type PartyDetail,
  type PhoneKind,
} from "@/lib/party";

interface ContactsTabProps {
  party: PartyDetail;
  onChanged: (party: PartyDetail) => void;
}

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

export function ContactsTab({ party, onChanged }: ContactsTabProps) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [position, setPosition] = useState("");
  const [email, setEmail] = useState("");
  const [phoneKind, setPhoneKind] = useState<PhoneKind>("MOBILE");
  const [phoneValue, setPhoneValue] = useState("");
  const [isPrimary, setIsPrimary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEscClose(adding, () => {
    setAdding(false);
    addTriggerRef.current?.focus();
  }, addTriggerRef);

  function resetForm() {
    setName("");
    setPosition("");
    setEmail("");
    setPhoneKind("MOBILE");
    setPhoneValue("");
    setIsPrimary(false);
  }

  async function handleAdd() {
    if (busy) return;
    if (!name.trim()) {
      setError("نام آشنا الزامی است.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await addPartyContact(party.id, {
        name: name.trim(),
        position: position.trim() || undefined,
        email: email.trim() || undefined,
        isPrimary,
        phones: phoneValue.trim()
          ? [{ kind: phoneKind, value: phoneValue.trim() }]
          : undefined,
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

  async function handleDelete(contactId: string) {
    setError(null);
    try {
      await deletePartyContact(party.id, contactId);
      onChanged({
        ...party,
        contacts: party.contacts.filter((contact) => contact.id !== contactId),
      });
    } catch (err) {
      setError(partyErrorMessage(err));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">آشنایان / تماس‌ها</h3>
        {!adding && (
          <Button ref={addTriggerRef} variant="secondary" size="sm" onClick={() => setAdding(true)}>
            افزودن آشنا
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-4 rounded-lg border border-primary-200 bg-primary-50/50 p-3" role="group" aria-label="افزودن آشنا">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <label htmlFor="c-name" className={fieldLabel}>نام *</label>
              <Input id="c-name" autoFocus className="text-sm" value={name}
                onChange={(e) => setName(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="c-position" className={fieldLabel}>سمت</label>
              <Input id="c-position" className="text-sm" value={position}
                onChange={(e) => setPosition(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="c-email" className={fieldLabel}>ایمیل</label>
              <Input id="c-email" className="text-sm" dir="ltr" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="c-phone" className={fieldLabel}>تلفن</label>
              <div className="flex gap-1.5">
                <select
                  value={phoneKind}
                  onChange={(e) => setPhoneKind(e.target.value as PhoneKind)}
                  aria-label="نوع تلفن آشنا"
                  className="h-10 w-24 rounded-md border border-slate-300 bg-white px-1.5 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                >
                  {PHONE_KINDS.map((item) => (
                    <option key={item} value={item}>{PHONE_KIND_LABELS[item]}</option>
                  ))}
                </select>
                <Input id="c-phone" className="text-sm" dir="ltr" value={phoneValue}
                  onChange={(e) => setPhoneValue(e.target.value)} autoComplete="off" />
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
              <input type="checkbox" checked={isPrimary}
                onChange={(e) => setIsPrimary(e.target.checked)}
                className="h-4 w-4 accent-primary-600" />
              تماس اصلی
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

      {party.contacts.length === 0 && !adding ? (
        <p className="py-6 text-center text-sm text-slate-400">آشنایی ثبت نشده است.</p>
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {party.contacts.map((contact) => (
            <li key={contact.id} className="rounded-lg border border-slate-200 p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
                    {contact.name}
                    {contact.isPrimary && (
                      <span className="rounded border border-primary-200 bg-primary-50 px-1.5 py-0.5 text-[10px] font-medium text-primary-700">
                        اصلی
                      </span>
                    )}
                  </p>
                  {contact.position && (
                    <p className="mt-0.5 text-xs text-slate-500">{contact.position}</p>
                  )}
                  {contact.email && (
                    <p className="mt-0.5 text-xs text-slate-500" dir="ltr">{contact.email}</p>
                  )}
                  {contact.phones.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5">
                      {contact.phones.map((phone, index) => (
                        <li key={phone.id ?? index} className="flex items-center gap-2 text-xs text-slate-600">
                          <span className="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500">
                            {PHONE_KIND_LABELS[phone.kind] ?? phone.kind}
                          </span>
                          <span dir="ltr">{phone.rawValue ?? phone.value ?? phone.normalizedValue}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <Button variant="ghost" size="sm" onClick={() => handleDelete(contact.id)}
                  aria-label={`حذف آشنا ${contact.name}`}
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
