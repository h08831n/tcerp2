"use client";

/**
 * CR-001 — Lead detail (Odoo-style): identity card + edit + status chain +
 * the explicit «تبدیل به فرصت فروش» operation + shared activities panel +
 * shared chatter. The party link is shown prominently — conversion never
 * creates a second party.
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DatePicker } from "@/components/ui/date-picker";
import { LeadStatusBadge } from "@/components/documents/status-badges";
import { CrmActivitiesPanel } from "@/components/crm/crm-activities-panel";
import { CrmTimelinePanel } from "@/components/crm/crm-timeline-panel";
import { faDigits, faMoney, jalali } from "@/lib/format";
import {
  LEAD_STATUS_LABELS,
  convertLead,
  userDisplayName,
  crmErrorMessage,
  fetchLead,
  fetchLeadTimeline,
  updateLead,
  type ConvertLeadBody,
  type LeadDto,
  type LeadStatus,
} from "@/lib/crm";
import { fetchUsers } from "@/lib/party";
import { useAuth } from "@/lib/auth-context";

interface UserOptionRaw {
  id: string;
  username: string;
  firstName?: string | null;
  lastName?: string | null;
}

function toUserOption(raw: unknown): EntityOption | null {
  const u = raw as UserOptionRaw;
  if (!u?.id) return null;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
  return { id: u.id, label: name || u.username };
}

export default function LeadDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();
  const { permissions } = useAuth();
  const canManage = permissions.includes("crm.manage");

  const [lead, setLead] = useState<LeadDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editVersion, setEditVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [convertOpen, setConvertOpen] = useState(false);
  const [convTitle, setConvTitle] = useState("");
  const [convAmount, setConvAmount] = useState("");
  const [convClose, setConvClose] = useState<string | null>(null);
  const [convSalesperson, setConvSalesperson] = useState<EntityOption | null>(null);
  const [converting, setConverting] = useState(false);
  const [convError, setConvError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    let cancelled = false;
    fetchLead(id)
      .then((data) => {
        if (cancelled) return;
        setLead(data);
        setEditName(data.name);
        setEditPhone(data.phone ?? "");
        setEditNotes(data.notes ?? "");
        setEditVersion(data.version);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(crmErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => load(), [load, reloadToken]);

  const timelineFetcher = useMemo(
    () => () => fetchLeadTimeline(id, 100),
    [id],
  );

  async function handleSave() {
    if (!lead) return;
    setSaving(true);
    setEditError(null);
    try {
      await updateLead(lead.id, {
        name: editName.trim(),
        phone: editPhone.trim() || undefined,
        notes: editNotes.trim() || undefined,
        version: editVersion,
      });
      setEditOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setEditError(crmErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleConvert() {
    if (!lead) return;
    setConverting(true);
    setConvError(null);
    try {
      const body: ConvertLeadBody = {
        ...(convTitle.trim() ? { title: convTitle.trim() } : {}),
        ...(convAmount.trim() ? { estimatedAmount: Number(convAmount.replace(/[^0-9.]/g, "")) } : {}),
        ...(convClose ? { expectedCloseDate: convClose } : {}),
        ...(convSalesperson ? { salespersonUserId: convSalesperson.id } : {}),
      };
      const result = await convertLead(lead.id, body);
      setConvertOpen(false);
      router.push(`/crm/opportunities/${result.opportunity.id}`);
    } catch (err) {
      setConvError(crmErrorMessage(err));
    } finally {
      setConverting(false);
    }
  }

  if (error) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {error}{" "}
        <button type="button" className="font-bold underline" onClick={() => setReloadToken((t) => t + 1)}>
          تلاش مجدد
        </button>
      </div>
    );
  }
  if (!lead) return <p className="text-sm text-slate-400">در حال بارگذاری…</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        {/* Identity card */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-800">{lead.name}</h2>
                <LeadStatusBadge status={lead.status} />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                ایجاد: {jalali(lead.createdAt)}
                {lead.phone && <> · تلفن: <span dir="ltr">{faDigits(lead.phone)}</span></>}
                {lead.source && <> · منبع: {lead.source}</>}
              </p>
            </div>
            <div className="flex gap-1">
              {canManage && (
                <Button size="sm" variant="secondary" onClick={() => setEditOpen(true)}>
                  ویرایش
                </Button>
              )}
              {canManage && lead.status !== "CONVERTED" && lead.status !== "LOST" && (
                <Button size="sm" onClick={() => setConvertOpen(true)}>
                  تبدیل به فرصت فروش
                </Button>
              )}
            </div>
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2">
            <p>
              <span className="text-slate-400">طرف‌حساب (هویت ثابت): </span>
              {lead.party ? (
                <a href={`/parties/${lead.party.id}`} className="font-medium text-primary-700 hover:underline">
                  {lead.party.nameFa} ↗
                </a>
              ) : (
                <span className="text-slate-400">متصل نیست (سرنخ قدیمی)</span>
              )}
            </p>
            <p>
              <span className="text-slate-400">مسئول پیگیری: </span>
              {userDisplayName(lead.salesperson)}
            </p>
            {lead.activity && (
              <>
                <p>
                  <span className="text-slate-400">فعالیت بعدی: </span>
                  {lead.activity.nextActivityAt
                    ? `${lead.activity.nextActivityTitle ?? ""} — ${jalali(lead.activity.nextActivityAt)}`
                    : "—"}
                </p>
                <p>
                  <span className="text-slate-400">عقب‌افتاده: </span>
                  <span className={lead.activity.overdueCount > 0 ? "font-bold text-rose-600" : ""}>
                    {faDigits(lead.activity.overdueCount)}
                  </span>
                </p>
              </>
            )}
          </div>

          {lead.notes && <p className="mt-2 whitespace-pre-line text-xs text-slate-600">{lead.notes}</p>}
        </section>

        <CrmActivitiesPanel relatedEntityType="lead" relatedEntityId={lead.id} refreshToken={reloadToken} />
      </div>

      <CrmTimelinePanel fetcher={timelineFetcher} refreshToken={reloadToken} />

      {/* Edit */}
      <Modal
        open={editOpen}
        title="ویرایش سرنخ"
        onClose={() => setEditOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {editError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {editError}
            </div>
          )}
          <div>
            <label htmlFor="lead-edit-name" className="mb-1 block text-xs font-medium text-slate-600">
              نام سرنخ
            </label>
            <Input id="lead-edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="lead-edit-phone" className="mb-1 block text-xs font-medium text-slate-600">
              تلفن
            </label>
            <Input id="lead-edit-phone" dir="ltr" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
          </div>
          <div>
            <label htmlFor="lead-edit-notes" className="mb-1 block text-xs font-medium text-slate-600">
              یادداشت
            </label>
            <textarea
              id="lead-edit-notes"
              rows={3}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
        </div>
      </Modal>

      {/* Convert */}
      <Modal
        open={convertOpen}
        title="تبدیل به فرصت فروش"
        onClose={() => setConvertOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setConvertOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleConvert()} disabled={converting}>
              {converting ? "در حال تبدیل…" : "تبدیل"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {convError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {convError}
            </div>
          )}
          <p className="rounded-md bg-sky-50 px-3 py-2 text-[11px] leading-5 text-sky-700">
            طرف‌حساب «{lead.party?.nameFa ?? lead.name}» حفظ می‌شود و تاریخچهٔ فعالیت‌ها دست‌نخورده می‌ماند.
            طرف‌حساب هنوز مشتری نیست؛ نقش مشتری فقط پس از قطعی شدن سفارش فروش اعطا می‌شود.
          </p>
          <div>
            <label htmlFor="conv-title" className="mb-1 block text-xs font-medium text-slate-600">
              عنوان فرصت (پیش‌فرض: نام سرنخ)
            </label>
            <Input id="conv-title" value={convTitle} onChange={(e) => setConvTitle(e.target.value)} placeholder={lead.name} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="conv-amount" className="mb-1 block text-xs font-medium text-slate-600">
                مبلغ احتمالی (ریال)
              </label>
              <Input id="conv-amount" dir="ltr" inputMode="numeric" value={convAmount} onChange={(e) => setConvAmount(e.target.value)} />
            </div>
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-600">تاریخ احتمالی نهایی شدن</span>
              <DatePicker value={convClose} onChange={setConvClose} aria-label="تاریخ احتمالی نهایی شدن" />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">
              مسئول فروش (پیش‌فرض: {userDisplayName(lead.salesperson)})
            </span>
            <EntitySelector
              endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
              mapItem={toUserOption}
              value={convSalesperson}
              onChange={setConvSalesperson}
              placeholder="تغییر مسئول…"
              ariaLabel="انتخاب مسئول فروش فرصت"
            />
          </div>
          {convAmount.trim() && <p className="text-[11px] text-slate-400">{faMoney(Number(convAmount.replace(/[^0-9.]/g, "")))}</p>}
        </div>
      </Modal>
    </div>
  );
}
