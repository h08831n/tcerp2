"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { useAuth } from "@/lib/auth-context";
import { jalali } from "@/lib/format";
import {
  PARTY_TYPE_LABELS,
  ownerDisplayName,
  setPartyOwner,
  updateParty,
  type PartyDetail,
} from "@/lib/party";

interface GeneralTabProps {
  party: PartyDetail;
  onChanged: (party: PartyDetail) => void;
}

interface FormState {
  nameFa: string;
  nameEn: string;
  internalCode: string;
  firstName: string;
  lastName: string;
  nationalCode: string;
  nationalId: string;
  economicCode: string;
  registrationNumber: string;
  birthDate: string | null;
  website: string;
  email: string;
  notes: string;
  owner: EntityOption | null;
}

function toFormState(party: PartyDetail): FormState {
  return {
    nameFa: party.nameFa ?? "",
    nameEn: party.nameEn ?? "",
    internalCode: party.internalCode ?? "",
    firstName: party.firstName ?? "",
    lastName: party.lastName ?? "",
    nationalCode: party.nationalCode ?? "",
    nationalId: party.nationalId ?? "",
    economicCode: party.economicCode ?? "",
    registrationNumber: party.registrationNumber ?? "",
    birthDate: party.birthDate ?? null,
    website: party.website ?? "",
    email: party.email ?? "",
    notes: party.notes ?? "",
    owner: party.owner
      ? {
          id: party.owner.id,
          label: ownerDisplayName(party.owner),
          sublabel: party.owner.username,
        }
      : null,
  };
}

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

export function GeneralTab({ party, onChanged }: GeneralTabProps) {
  const isPerson = party.type === "PERSON";
  const { user, permissions } = useAuth();
  const canChangeOwner =
    user?.role === "MANAGER" ||
    permissions.some((permission) => /manager|owner/i.test(permission));

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(() => toFormState(party));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [ownerError, setOwnerError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);

  function startEdit() {
    setForm(toFormState(party));
    setError(null);
    setConflict(false);
    setOwnerError(null);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    setConflict(false);
    editButtonRef.current?.focus();
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const body = {
        version: party.version,
        nameFa: form.nameFa.trim(),
        ...(isPerson
          ? {
              firstName: form.firstName.trim() || undefined,
              lastName: form.lastName.trim() || undefined,
              nationalCode: form.nationalCode.trim() || undefined,
              birthDate: form.birthDate ?? undefined,
            }
          : {
              nameEn: form.nameEn.trim() || undefined,
              nationalId: form.nationalId.trim() || undefined,
              economicCode: form.economicCode.trim() || undefined,
              registrationNumber: form.registrationNumber.trim() || undefined,
              website: form.website.trim() || undefined,
            }),
        internalCode: form.internalCode.trim() || undefined,
        email: form.email.trim() || undefined,
        notes: form.notes.trim() || undefined,
      };
      const updated = await updateParty(party.id, body);
      // Owner change is a separate managers-only endpoint.
      const ownerChanged =
        (form.owner?.id ?? null) !== (party.owner?.id ?? null);
      let result = updated;
      if (ownerChanged && form.owner) {
        try {
          result = await setPartyOwner(party.id, form.owner.id);
        } catch (ownerErr) {
          setOwnerError(
            ownerErr instanceof Error ? ownerErr.message : "خطا در تغییر مالک",
          );
        }
      }
      setEditing(false);
      editButtonRef.current?.focus();
      onChanged(result);
    } catch (err) {
      if (err instanceof Error && err.message.includes("VERSION_CONFLICT")) {
        setConflict(true);
      } else if (err instanceof Error && err.name === "ApiError" && (err as { status?: number }).status === 409) {
        setConflict(true);
      } else {
        setError(err instanceof Error ? err.message : "خطا در ذخیره");
      }
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S saves while editing.
  useEffect(() => {
    if (!editing) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, form, party.version, saving]);

  // Escape exits edit mode (when not closed by an inner form first).
  useEffect(() => {
    if (!editing) return;
    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input,textarea,select")) return;
        cancelEdit();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, party.version]);

  const usersEndpoint = (search: string) => `/users?search=${encodeURIComponent(search)}`;
  const mapUser = (raw: unknown) => {
    const item = raw as Record<string, unknown>;
    const id = item?.id !== undefined ? String(item.id) : "";
    if (!id) return null;
    const name = [item.firstName, item.lastName]
      .filter((part): part is string => typeof part === "string" && part.length > 0)
      .join(" ")
      .trim();
    return {
      id,
      label: name || (typeof item.username === "string" ? item.username : id),
      sublabel: typeof item.username === "string" ? item.username : undefined,
    };
  };

  if (editing) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-bold text-slate-800">ویرایش اطلاعات</h3>

        {conflict && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <p className="font-bold">رکورد توسط کاربر دیگری تغییر کرده است.</p>
            <p className="mt-1 text-xs">
              برای مشاهده نسخه جدید، صفحه را بازخوانی کنید؛ تغییرات شما ذخیره نشد.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => window.location.reload()}>
                بازخوانی صفحه
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConflict(false)}>
                بستن
              </Button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isPerson ? (
            <>
              <div>
                <label htmlFor="g-firstName" className={fieldLabel}>نام</label>
                <Input id="g-firstName" className="text-sm" value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-lastName" className={fieldLabel}>نام خانوادگی</label>
                <Input id="g-lastName" className="text-sm" value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-nationalCode" className={fieldLabel}>کد ملی</label>
                <Input id="g-nationalCode" className="text-sm" dir="ltr" value={form.nationalCode}
                  onChange={(e) => setForm({ ...form, nationalCode: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-birthDate" className={fieldLabel}>تاریخ تولد</label>
                <JalaliDateInput id="g-birthDate" value={form.birthDate}
                  onChange={(iso) => setForm({ ...form, birthDate: iso })}
                  ariaLabel="تاریخ تولد (شمسی)" />
              </div>
            </>
          ) : (
            <>
              <div>
                <label htmlFor="g-nameFa" className={fieldLabel}>نام فارسی *</label>
                <Input id="g-nameFa" className="text-sm" value={form.nameFa}
                  onChange={(e) => setForm({ ...form, nameFa: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-nameEn" className={fieldLabel}>نام لاتین</label>
                <Input id="g-nameEn" className="text-sm" dir="ltr" value={form.nameEn}
                  onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-nationalId" className={fieldLabel}>شناسه ملی</label>
                <Input id="g-nationalId" className="text-sm" dir="ltr" value={form.nationalId}
                  onChange={(e) => setForm({ ...form, nationalId: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-economicCode" className={fieldLabel}>کد اقتصادی</label>
                <Input id="g-economicCode" className="text-sm" dir="ltr" value={form.economicCode}
                  onChange={(e) => setForm({ ...form, economicCode: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-regNumber" className={fieldLabel}>شماره ثبت</label>
                <Input id="g-regNumber" className="text-sm" dir="ltr" value={form.registrationNumber}
                  onChange={(e) => setForm({ ...form, registrationNumber: e.target.value })} />
              </div>
              <div>
                <label htmlFor="g-website" className={fieldLabel}>وب‌سایت</label>
                <Input id="g-website" className="text-sm" dir="ltr" value={form.website}
                  onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </div>
            </>
          )}
          <div>
            <label htmlFor="g-internalCode" className={fieldLabel}>کد داخلی</label>
            <Input id="g-internalCode" className="text-sm" dir="ltr" value={form.internalCode}
              onChange={(e) => setForm({ ...form, internalCode: e.target.value })} />
          </div>
          <div>
            <label htmlFor="g-email" className={fieldLabel}>ایمیل</label>
            <Input id="g-email" className="text-sm" dir="ltr" type="email" value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          {canChangeOwner && (
            <div>
              <span className={fieldLabel}>مالک پرونده</span>
              <EntitySelector
                endpoint={usersEndpoint}
                mapItem={mapUser}
                value={form.owner}
                onChange={(value) => setForm({ ...form, owner: value })}
                placeholder="جستجوی کاربر…"
                ariaLabel="انتخاب مالک پرونده"
              />
            </div>
          )}
        </div>

        <div className="mt-4">
          <label htmlFor="g-notes" className={fieldLabel}>یادداشت</label>
          <textarea
            id="g-notes"
            rows={3}
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>

        {error && (
          <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {ownerError && (
          <div role="alert" className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
            ذخیره اطلاعات انجام شد اما تغییر مالک ناموفق بود: {ownerError}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
          <Button onClick={save} disabled={saving}>
            {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
          </Button>
          <Button ref={cancelButtonRef} variant="secondary" onClick={cancelEdit} disabled={saving}>
            انصراف (Esc)
          </Button>
        </div>
      </div>
    );
  }

  // View mode
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "نوع", value: PARTY_TYPE_LABELS[party.type] ?? party.type },
    { label: isPerson ? "نام کامل" : "نام", value: party.nameFa },
    ...(isPerson
      ? [
          { label: "نام کوچک", value: party.firstName ?? "—" },
          { label: "نام خانوادگی", value: party.lastName ?? "—" },
          { label: "کد ملی", value: party.nationalCode ?? "—" },
          { label: "تاریخ تولد", value: party.birthDate ? jalali(party.birthDate) : "—" },
        ]
      : [
          { label: "نام لاتین", value: party.nameEn ?? "—" },
          { label: "شناسه ملی", value: party.nationalId ?? "—" },
          { label: "کد اقتصادی", value: party.economicCode ?? "—" },
          { label: "شماره ثبت", value: party.registrationNumber ?? "—" },
          { label: "وب‌سایت", value: party.website ?? "—" },
        ]),
    { label: "کد داخلی", value: party.internalCode ?? "—" },
    { label: "ایمیل", value: party.email ?? "—" },
    { label: "مالک", value: ownerDisplayName(party.owner) },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">اطلاعات عمومی</h3>
        <Button ref={editButtonRef} variant="secondary" size="sm" onClick={startEdit}>
          ویرایش
        </Button>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-[11px] text-slate-400">{row.label}</dt>
            <dd className="mt-0.5 truncate text-sm text-slate-800" dir={/^[A-Za-z0-9.@:/ -]+$/.test(String(row.value)) ? "ltr" : undefined}>
              {row.value || "—"}
            </dd>
          </div>
        ))}
        {party.notes && (
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-[11px] text-slate-400">یادداشت</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{party.notes}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
