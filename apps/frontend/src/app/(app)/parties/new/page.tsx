"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { fetchUsers } from "@/lib/party";
import { faDigits, normalizeMobile } from "@/lib/format";
import {
  PARTY_ROLES,
  PARTY_ROLE_LABELS,
  PHONE_KINDS,
  PHONE_KIND_LABELS,
  checkDuplicate,
  createParty,
  partyErrorMessage,
  type CreatePartyBody,
  type DuplicateExact,
  type DuplicateSimilar,
  type PhoneKind,
  type PartyRole,
  type PartyType,
} from "@/lib/party";

interface PhoneDraft {
  kind: PhoneKind;
  value: string;
  isPrimary: boolean;
}

export default function NewPartyPage() {
  const router = useRouter();

  const [type, setType] = useState<PartyType>("COMPANY");
  const [nameFa, setNameFa] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [internalCode, setInternalCode] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [nationalCode, setNationalCode] = useState("");
  const [birthDate, setBirthDate] = useState<string | null>(null);
  const [nationalId, setNationalId] = useState("");
  const [economicCode, setEconomicCode] = useState("");
  const [registrationNumber, setRegistrationNumber] = useState("");
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [notes, setNotes] = useState("");
  const [roles, setRoles] = useState<PartyRole[]>(["CUSTOMER"]);
  const [owner, setOwner] = useState<EntityOption | null>(null);
  const [phones, setPhones] = useState<PhoneDraft[]>([
    { kind: "MOBILE", value: "", isPrimary: true },
  ]);

  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [exactMatch, setExactMatch] = useState<DuplicateExact | null>(null);
  const [similarMatches, setSimilarMatches] = useState<DuplicateSimilar[]>([]);
  const [postWarnings, setPostWarnings] = useState<
    { type: string; partyId: string; nameFa: string; similarity: number }[] | null
  >(null);
  const [pendingPartyId, setPendingPartyId] = useState<string | null>(null);

  const isPerson = type === "PERSON";
  const effectiveNameFa = useMemo(
    () => (isPerson ? `${firstName} ${lastName}`.trim() : nameFa.trim()),
    [isPerson, firstName, lastName, nameFa],
  );
  const primaryMobile = phones.find(
    (phone) => phone.kind === "MOBILE" && phone.value.trim(),
  );

  function toggleRole(role: PartyRole) {
    setRoles((current) =>
      current.includes(role)
        ? current.filter((item) => item !== role)
        : [...current, role],
    );
  }

  function updatePhone(index: number, patch: Partial<PhoneDraft>) {
    setPhones((current) =>
      current.map((phone, i) => (i === index ? { ...phone, ...patch } : phone)),
    );
  }

  function buildBody(): CreatePartyBody {
    return {
      type,
      nameFa: effectiveNameFa,
      ...(isPerson
        ? { firstName: firstName.trim() || undefined, lastName: lastName.trim() || undefined }
        : { nameEn: nameEn.trim() || undefined }),
      internalCode: internalCode.trim() || undefined,
      ...(isPerson
        ? { nationalCode: nationalCode.trim() || undefined }
        : {
            nationalId: nationalId.trim() || undefined,
            economicCode: economicCode.trim() || undefined,
            registrationNumber: registrationNumber.trim() || undefined,
          }),
      birthDate: isPerson && birthDate ? birthDate : undefined,
      website: !isPerson && website.trim() ? website.trim() : undefined,
      email: email.trim() || undefined,
      notes: notes.trim() || undefined,
      ownerUserId: owner?.id,
      roles,
      phones: phones
        .filter((phone) => phone.value.trim())
        .map((phone) => ({
          kind: phone.kind,
          value: phone.kind === "MOBILE" ? normalizeMobile(phone.value) : phone.value.trim(),
          isPrimary: phone.isPrimary,
        })),
    };
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting || checking) return;
    setFormError(null);
    setExactMatch(null);
    setSimilarMatches([]);

    if (!effectiveNameFa) {
      setFormError(
        isPerson ? "نام و نام خانوادگی الزامی است." : "نام فارسی الزامی است.",
      );
      return;
    }
    if (roles.length === 0) {
      setFormError("حداقل یک نقش باید انتخاب شود.");
      return;
    }

    // Step 1: duplicate check.
    setChecking(true);
    let similar: DuplicateSimilar[] = [];
    try {
      const result = await checkDuplicate({
        mobile: primaryMobile ? normalizeMobile(primaryMobile.value) : undefined,
        nameFa: effectiveNameFa,
      });
      similar = result.similar ?? [];
      if (result.exact) {
        setExactMatch(result.exact);
        setChecking(false);
        return;
      }
    } catch (error) {
      setFormError(partyErrorMessage(error));
      setChecking(false);
      return;
    }
    setChecking(false);

    // Step 2: similar-name warnings (proceed allowed).
    if (similar.length > 0) {
      setSimilarMatches(similar);
      return;
    }

    await doCreate();
  }

  async function doCreate() {
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    setSimilarMatches([]);
    try {
      const result = await createParty(buildBody());
      if (result.warnings && result.warnings.length > 0) {
        setPostWarnings(result.warnings);
        setPendingPartyId(result.party.id);
        setSubmitting(false);
        return;
      }
      router.push(`/parties/${result.party.id}`);
    } catch (error) {
      setFormError(partyErrorMessage(error));
      setSubmitting(false);
    }
  }

  const usersEndpoint = useMemo(() => (search: string) => `/users?search=${encodeURIComponent(search)}`, []);
  const mapUser = useMemo(
    () => (raw: unknown) => {
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
    },
    [],
  );

  const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";
  const fieldInput = "text-sm";

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">ثبت مشتری جدید</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            پیش از ذخیره، تکراری‌بودن به‌صورت خودکار بررسی می‌شود.
          </p>
        </div>
        <Link href="/parties" tabIndex={-1}>
          <Button variant="ghost" size="sm">
            بازگشت به فهرست
          </Button>
        </Link>
      </div>

      <form onSubmit={handleSubmit} noValidate>
        <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          {/* Type toggle */}
          <fieldset>
            <legend className={fieldLabel}>نوع</legend>
            <div className="inline-flex rounded-md border border-slate-300 p-0.5" role="group" aria-label="نوع مشتری">
              {(["PERSON", "COMPANY"] as PartyType[]).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setType(value)}
                  aria-pressed={type === value}
                  className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
                    type === value
                      ? "bg-primary-600 text-white"
                      : "text-slate-600 hover:bg-slate-100"
                  }`}
                >
                  {value === "PERSON" ? "شخص" : "شرکت"}
                </button>
              ))}
            </div>
          </fieldset>

          {/* Person fields */}
          {isPerson ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="firstName" className={fieldLabel}>نام *</label>
                <Input id="firstName" inputSize="md" className={fieldInput} value={firstName}
                  onChange={(e) => setFirstName(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="lastName" className={fieldLabel}>نام خانوادگی *</label>
                <Input id="lastName" inputSize="md" className={fieldInput} value={lastName}
                  onChange={(e) => setLastName(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="nationalCode" className={fieldLabel}>کد ملی</label>
                <Input id="nationalCode" inputSize="md" className={fieldInput} dir="ltr" value={nationalCode}
                  onChange={(e) => setNationalCode(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="birthDate" className={fieldLabel}>تاریخ تولد</label>
                <JalaliDateInput id="birthDate" value={birthDate} onChange={setBirthDate}
                  ariaLabel="تاریخ تولد (شمسی)" />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="companyNameFa" className={fieldLabel}>نام فارسی *</label>
                <Input id="companyNameFa" inputSize="md" className={fieldInput} value={nameFa}
                  onChange={(e) => setNameFa(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="companyNameEn" className={fieldLabel}>نام لاتین</label>
                <Input id="companyNameEn" inputSize="md" className={fieldInput} dir="ltr" value={nameEn}
                  onChange={(e) => setNameEn(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="nationalId" className={fieldLabel}>شناسه ملی</label>
                <Input id="nationalId" inputSize="md" className={fieldInput} dir="ltr" value={nationalId}
                  onChange={(e) => setNationalId(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="economicCode" className={fieldLabel}>کد اقتصادی</label>
                <Input id="economicCode" inputSize="md" className={fieldInput} dir="ltr" value={economicCode}
                  onChange={(e) => setEconomicCode(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="registrationNumber" className={fieldLabel}>شماره ثبت</label>
                <Input id="registrationNumber" inputSize="md" className={fieldInput} dir="ltr" value={registrationNumber}
                  onChange={(e) => setRegistrationNumber(e.target.value)} autoComplete="off" />
              </div>
              <div>
                <label htmlFor="website" className={fieldLabel}>وب‌سایت</label>
                <Input id="website" inputSize="md" className={fieldInput} dir="ltr" value={website}
                  onChange={(e) => setWebsite(e.target.value)} autoComplete="off" />
              </div>
            </div>
          )}

          {/* Common fields */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="internalCode" className={fieldLabel}>کد داخلی</label>
              <Input id="internalCode" inputSize="md" className={fieldInput} dir="ltr" value={internalCode}
                onChange={(e) => setInternalCode(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <label htmlFor="email" className={fieldLabel}>ایمیل</label>
              <Input id="email" inputSize="md" className={fieldInput} dir="ltr" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} autoComplete="off" />
            </div>
            <div>
              <span className={fieldLabel}>مالک (کاربر مسئول)</span>
              <EntitySelector
                endpoint={usersEndpoint}
                mapItem={mapUser}
                value={owner}
                onChange={setOwner}
                placeholder="جستجوی کاربر…"
                ariaLabel="انتخاب مالک پرونده"
              />
            </div>
          </div>

          <div>
            <label htmlFor="notes" className={fieldLabel}>یادداشت</label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>

          {/* Roles */}
          <fieldset>
            <legend className={fieldLabel}>نقش‌ها *</legend>
            <div className="flex flex-wrap gap-4">
              {PARTY_ROLES.map((role) => (
                <label key={role} className="inline-flex cursor-pointer items-center gap-1.5 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={roles.includes(role)}
                    onChange={() => toggleRole(role)}
                    className="h-4 w-4 accent-primary-600"
                  />
                  {PARTY_ROLE_LABELS[role]}
                </label>
              ))}
            </div>
          </fieldset>

          {/* Phones repeater */}
          <fieldset>
            <legend className={fieldLabel}>تلفن‌ها</legend>
            <div className="space-y-2">
              {phones.map((phone, index) => {
                const normalized =
                  phone.kind === "MOBILE" && phone.value.trim()
                    ? normalizeMobile(phone.value)
                    : null;
                return (
                  <div key={index} className="flex flex-wrap items-start gap-2">
                    <select
                      value={phone.kind}
                      onChange={(e) => updatePhone(index, { kind: e.target.value as PhoneKind })}
                      aria-label={`نوع تلفن ${index + 1}`}
                      className="h-10 w-28 rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                    >
                      {PHONE_KINDS.map((kind) => (
                        <option key={kind} value={kind}>
                          {PHONE_KIND_LABELS[kind]}
                        </option>
                      ))}
                    </select>
                    <div className="min-w-48 flex-1">
                      <Input
                        dir="ltr"
                        value={phone.value}
                        onChange={(e) => updatePhone(index, { value: e.target.value })}
                        aria-label={`${PHONE_KIND_LABELS[phone.kind]} ${index + 1}`}
                        autoComplete="off"
                      />
                      {normalized && normalized !== phone.value.trim() && (
                        <p className="mt-1 text-[11px] text-slate-400" dir="ltr">
                          {faDigits(normalized)}
                        </p>
                      )}
                    </div>
                    <label className="inline-flex h-10 cursor-pointer items-center gap-1.5 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={phone.isPrimary}
                        onChange={(e) => {
                          const isPrimary = e.target.checked;
                          setPhones((current) =>
                            current.map((item, i) => ({
                              ...item,
                              isPrimary: i === index ? isPrimary : isPrimary ? false : item.isPrimary,
                            })),
                          );
                        }}
                        className="h-4 w-4 accent-primary-600"
                      />
                      اصلی
                    </label>
                    <Button
                      variant="ghost"
                      size="md"
                      onClick={() => setPhones((current) => current.filter((_, i) => i !== index))}
                      disabled={phones.length === 1}
                      aria-label={`حذف تلفن ${index + 1}`}
                      className="text-red-500 hover:bg-red-50"
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                        strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M10 11v6M14 11v6" />
                      </svg>
                    </Button>
                  </div>
                );
              })}
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              onClick={() =>
                setPhones((current) => [
                  ...current,
                  { kind: "PHONE", value: "", isPrimary: false },
                ])
              }
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              افزودن تلفن
            </Button>
          </fieldset>

          {/* Errors */}
          {formError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}

          {/* Blocking exact duplicate */}
          {exactMatch && (
            <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-bold">رکورد تکراری یافت شد.</p>
              <p className="mt-1">
                «{exactMatch.nameFa}» با همین شماره موبایل قبلاً ثبت شده است.
              </p>
              <Link
                href={`/parties/${exactMatch.partyId}`}
                className="mt-2 inline-flex items-center gap-1 font-bold text-red-700 underline"
              >
                مشاهده رکورد موجود
              </Link>
              <Button variant="secondary" size="sm" className="ms-3" onClick={() => setExactMatch(null)}>
                اصلاح اطلاعات
              </Button>
            </div>
          )}

          {/* Similar-name warnings before submit */}
          {similarMatches.length > 0 && (
            <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-bold">نام‌های مشابه یافت شد:</p>
              <ul className="mt-2 space-y-1">
                {similarMatches.map((item) => (
                  <li key={item.partyId} className="flex items-center justify-between gap-2">
                    <Link href={`/parties/${item.partyId}`} className="font-medium underline">
                      {item.nameFa}
                    </Link>
                    <span className="text-xs text-amber-700">
                      شباهت: {faDigits(Math.round(item.similarity * 100))}٪
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={doCreate} disabled={submitting}>
                  ادامه و ثبت
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setSimilarMatches([])}>
                  بازگشت به فرم
                </Button>
              </div>
            </div>
          )}

          {/* Warnings returned by POST */}
          {postWarnings && pendingPartyId && (
            <div role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-bold">رکورد با هشدار ثبت شد:</p>
              <ul className="mt-2 space-y-1">
                {postWarnings.map((warning) => (
                  <li key={`${warning.type}-${warning.partyId}`} className="flex items-center justify-between gap-2">
                    <span>
                      نام مشابه:{" "}
                      <Link href={`/parties/${warning.partyId}`} className="font-medium underline">
                        {warning.nameFa}
                      </Link>
                    </span>
                    <span className="text-xs text-amber-700">
                      شباهت: {faDigits(Math.round(warning.similarity * 100))}٪
                    </span>
                  </li>
                ))}
              </ul>
              <Button
                size="sm"
                className="mt-3"
                onClick={() => router.push(`/parties/${pendingPartyId}`)}
              >
                ادامه
              </Button>
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 border-t border-slate-100 pt-4">
            <Button type="submit" disabled={submitting || checking}>
              {checking ? "بررسی تکراری…" : submitting ? "در حال ذخیره…" : "ذخیره"}
            </Button>
            <Button variant="secondary" onClick={() => router.push("/parties")} disabled={submitting}>
              انصراف
            </Button>
            <span className="text-[11px] text-slate-400">
              کلیدهای میان‌بر: Enter برای ذخیره فرم
            </span>
          </div>
        </div>
      </form>
    </div>
  );
}
