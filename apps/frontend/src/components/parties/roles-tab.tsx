"use client";

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEscClose } from "@/components/parties/use-esc-close";
import { jalali } from "@/lib/format";
import {
  PARTY_ROLES,
  PARTY_ROLE_LABELS,
  addPartyRole,
  partyErrorMessage,
  removePartyRole,
  type PartyDetail,
  type PartyRole,
} from "@/lib/party";

interface RolesTabProps {
  party: PartyDetail;
  onChanged: (party: PartyDetail) => void;
}

export function RolesTab({ party, onChanged }: RolesTabProps) {
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState<PartyRole>("CUSTOMER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEscClose(adding, () => {
    setAdding(false);
    addTriggerRef.current?.focus();
  }, addTriggerRef);

  const currentRoles = party.roles.map((entry) => entry.role);
  const available = PARTY_ROLES.filter((role) => !currentRoles.includes(role));

  async function handleAdd() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await addPartyRole(party.id, selected);
      setAdding(false);
      addTriggerRef.current?.focus();
      onChanged(updated);
    } catch (err) {
      setError(partyErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(role: PartyRole) {
    setError(null);
    try {
      const updated = await removePartyRole(party.id, role);
      onChanged(updated);
    } catch (err) {
      setError(partyErrorMessage(err));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">نقش‌ها</h3>
        {!adding && available.length > 0 && (
          <Button ref={addTriggerRef} variant="secondary" size="sm" onClick={() => setAdding(true)}>
            افزودن نقش
          </Button>
        )}
      </div>

      {adding && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-primary-200 bg-primary-50/50 p-3" role="group" aria-label="افزودن نقش">
          <select
            autoFocus
            value={selected}
            onChange={(e) => setSelected(e.target.value as PartyRole)}
            aria-label="انتخاب نقش"
            className="h-10 w-44 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            {available.map((role) => (
              <option key={role} value={role}>
                {PARTY_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
          <Button onClick={handleAdd} disabled={busy}>
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
      )}

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {party.roles.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">نقشی ثبت نشده است.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {party.roles.map((entry) => (
            <li
              key={entry.role}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 py-1 pe-1 ps-2.5"
            >
              <span className="text-sm font-medium text-slate-700">
                {PARTY_ROLE_LABELS[entry.role] ?? entry.role}
              </span>
              <span className="text-[11px] text-slate-400">از {jalali(entry.since)}</span>
              <button
                type="button"
                onClick={() => handleRemove(entry.role)}
                className="flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-red-50 hover:text-red-600"
                aria-label={`حذف نقش ${PARTY_ROLE_LABELS[entry.role] ?? entry.role}`}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
