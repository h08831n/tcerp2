"use client";

/**
 * CR-001 — Opportunity detail (Odoo-style): identity card + stage pipeline +
 * expected close date + quotations list (from the sales module — ONE entity,
 * quotation→order on the same document) + shared activities + chatter.
 *
 * The party link is stable across the whole funnel; customer-hood appears
 * here only after a valid SALES_ORDER activation (backend-enforced).
 */

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DatePicker } from "@/components/ui/date-picker";
import { OpportunityStatusBadge, SaleStatusBadge } from "@/components/documents/status-badges";
import { CrmActivitiesPanel } from "@/components/crm/crm-activities-panel";
import { CrmTimelinePanel } from "@/components/crm/crm-timeline-panel";
import { faDigits, faMoneyExact, jalali } from "@/lib/format";
import {
  OPPORTUNITY_STATUS_LABELS,
  OPPORTUNITY_TRANSITIONS,
  crmErrorMessage,
  fetchLostReasons,
  fetchOpportunity,
  fetchOpportunityTimeline,
  updateOpportunity,
  type OpportunityDto,
  type OpportunityStatus,
} from "@/lib/crm";
import { fetchSales } from "@/lib/sales";
import type { LostReasonDto } from "@/lib/crm";
import { useAuth } from "@/lib/auth-context";

export default function OpportunityDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const router = useRouter();
  const { permissions } = useAuth();
  const canManage = permissions.includes("crm.manage");

  const [opp, setOpp] = useState<OpportunityDto | null>(null);
  const [quotes, setQuotes] = useState<{ id: string; documentNumber: string; status: string; total: string; documentDate: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    estimatedAmount: "",
    estimatedTonnage: "",
    expectedCloseDate: null as string | null,
    status: "" as OpportunityStatus | "",
    lostReasonId: "",
    version: 0,
  });
  const [lostReasons, setLostReasons] = useState<LostReasonDto[]>([]);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    let cancelled = false;
    Promise.all([
      fetchOpportunity(id),
      fetchSales({ opportunityId: id, pageSize: 50 }).catch(() => null),
    ])
      .then(([data, sales]) => {
        if (cancelled) return;
        setOpp(data);
        setForm({
          title: data.title,
          description: data.description ?? "",
          estimatedAmount: data.estimatedAmount ?? "",
          estimatedTonnage: data.estimatedTonnage ?? "",
          expectedCloseDate: data.expectedCloseDate ?? null,
          status: "",
          lostReasonId: data.lostReasonId ?? "",
          version: data.version,
        });
        setQuotes(
          sales
            ? sales.items.map((d) => ({
                id: d.id,
                documentNumber: d.documentNumber,
                status: d.status,
                total: String(d.totals?.total ?? ""),
                documentDate: d.documentDate,
              }))
            : [],
        );
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(crmErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => load(), [load, reloadToken]);

  const timelineFetcher = useMemo(() => () => fetchOpportunityTimeline(id, 100), [id]);

  const allowedTargets = opp ? OPPORTUNITY_TRANSITIONS[opp.status] : [];

  async function handleStage(target: OpportunityStatus, lostReasonId?: string) {
    if (!opp) return;
    try {
      await updateOpportunity(opp.id, {
        status: target,
        ...(target === "LOST" && lostReasonId ? { lostReasonId } : {}),
        version: opp.version,
      });
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(crmErrorMessage(err));
    }
  }

  async function handleSave() {
    if (!opp) return;
    setSaving(true);
    setEditError(null);
    try {
      const status = form.status || undefined;
      await updateOpportunity(opp.id, {
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        estimatedAmount: form.estimatedAmount.trim() ? Number(form.estimatedAmount.replace(/[^0-9.]/g, "")) : undefined,
        estimatedTonnage: form.estimatedTonnage.trim() ? Number(form.estimatedTonnage.replace(/[^0-9.]/g, "")) : undefined,
        expectedCloseDate: form.expectedCloseDate ?? undefined,
        ...(status ? { status } : {}),
        ...(status === "LOST" ? { lostReasonId: form.lostReasonId || undefined } : {}),
        version: form.version,
      });
      setEditOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setEditError(crmErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  function openEdit() {
    if (!opp) return;
    setForm({
      title: opp.title,
      description: opp.description ?? "",
      estimatedAmount: opp.estimatedAmount ?? "",
      estimatedTonnage: opp.estimatedTonnage ?? "",
      expectedCloseDate: opp.expectedCloseDate ?? null,
      status: "",
      lostReasonId: opp.lostReasonId ?? "",
      version: opp.version,
    });
    setEditOpen(true);
    if (lostReasons.length === 0) {
      fetchLostReasons()
        .then(setLostReasons)
        .catch(() => undefined);
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
  if (!opp) return <p className="text-sm text-slate-400">در حال بارگذاری…</p>;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-4">
        {/* Identity card */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold text-slate-800">{opp.title}</h2>
                <OpportunityStatusBadge status={opp.status} />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                ایجاد: {jalali(opp.createdAt)}
                {opp.estimatedAmount && <> · مبلغ احتمالی: {faMoneyExact(opp.estimatedAmount)} ریال</>}
                {opp.estimatedTonnage && <> · تناژ: {faDigits(opp.estimatedTonnage)}</>}
              </p>
            </div>
            {canManage && (
              <Button size="sm" variant="secondary" onClick={openEdit}>
                ویرایش / تغییر مرحله
              </Button>
            )}
          </div>

          {/* Stage pipeline strip */}
          <div className="mt-3 flex flex-wrap gap-1" aria-label="مراحل Pipeline">
            {(["OPEN", "QUALIFIED", "QUOTED", "WON"] as OpportunityStatus[]).map((stage) => (
              <span
                key={stage}
                className={`rounded-full px-2.5 py-0.5 text-[11px] ${
                  opp.status === stage
                    ? "bg-primary-600 font-medium text-white"
                    : "bg-slate-100 text-slate-500"
                }`}
              >
                {OPPORTUNITY_STATUS_LABELS[stage]}
              </span>
            ))}
            {opp.status === "LOST" && (
              <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-[11px] font-medium text-rose-700">
                باخته{opp.lostReason ? ` — ${opp.lostReason.nameFa}` : ""}
              </span>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 gap-2 rounded-lg bg-slate-50 p-3 text-xs text-slate-600 sm:grid-cols-2">
            <p>
              <span className="text-slate-400">طرف‌حساب (هویت ثابت): </span>
              <Link href={`/parties/${opp.customer.id}`} className="font-medium text-primary-700 hover:underline">
                {opp.customer.nameFa} ↗
              </Link>
            </p>
            <p>
              <span className="text-slate-400">مسئول فروش: </span>
              {opp.salesperson ? `${[opp.salesperson.firstName, opp.salesperson.lastName].filter(Boolean).join(" ") || opp.salesperson.username}` : "—"}
            </p>
            <p>
              <span className="text-slate-400">تاریخ احتمالی نهایی شدن: </span>
              {opp.expectedCloseDate ? jalali(opp.expectedCloseDate) : "—"}
            </p>
            {opp.lead && (
              <p>
                <span className="text-slate-400">منبع: </span>
                <Link href={`/crm/leads/${opp.lead.id}`} className="text-primary-700 hover:underline">
                  تبدیل از سرنخ «{opp.lead.name}» ↗
                </Link>
              </p>
            )}
            {opp.activity && (
              <>
                <p>
                  <span className="text-slate-400">فعالیت بعدی: </span>
                  {opp.activity.nextActivityAt
                    ? `${opp.activity.nextActivityTitle ?? ""} — ${jalali(opp.activity.nextActivityAt)}`
                    : "—"}
                </p>
                <p>
                  <span className="text-slate-400">عقب‌افتاده: </span>
                  <span className={opp.activity.overdueCount > 0 ? "font-bold text-rose-600" : ""}>
                    {faDigits(opp.activity.overdueCount)}
                  </span>
                </p>
              </>
            )}
          </div>
          {opp.description && <p className="mt-2 whitespace-pre-line text-xs text-slate-600">{opp.description}</p>}
        </section>

        {/* Quotations (sales module — ONE document entity) */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="پیش‌فاکتورها">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-800">پیش‌فاکتورها / سفارش‌های فروش</h3>
            {canManage && (
              <Link
                href={`/sales/new?opportunityId=${opp.id}&partyId=${opp.customer.id}`}
                className="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700"
              >
                پیش‌فاکتور جدید
              </Link>
            )}
          </div>
          <p className="mb-2 rounded-md bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
            ثبت پیش‌فاکتور به‌تنهایی طرف‌حساب را مشتری نمی‌کند؛ نقش مشتری فقط پس از قطعی شدن سفارش فروش اعطا می‌شود.
          </p>
          {quotes === null ? (
            <p className="text-xs text-slate-400">در حال بارگذاری…</p>
          ) : quotes.length === 0 ? (
            <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
              هنوز پیش‌فاکتوری ثبت نشده است.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {quotes.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2">
                  <Link href={`/sales/${d.id}`} className="text-sm font-medium text-primary-700 hover:underline" dir="ltr">
                    {faDigits(d.documentNumber)} ↗
                  </Link>
                  <SaleStatusBadge status={d.status as never} />
                  <span className="text-xs text-slate-500">{jalali(d.documentDate)}</span>
                  <span className="text-xs text-slate-700">{faMoneyExact(d.total)} ریال</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <CrmActivitiesPanel relatedEntityType="opportunity" relatedEntityId={opp.id} refreshToken={reloadToken} />
      </div>

      <CrmTimelinePanel fetcher={timelineFetcher} refreshToken={reloadToken} />

      {/* Edit + stage transitions */}
      <Modal
        open={editOpen}
        title="ویرایش فرصت فروش"
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
            <label htmlFor="opp-title" className="mb-1 block text-xs font-medium text-slate-600">
              عنوان
            </label>
            <Input id="opp-title" value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="opp-amount" className="mb-1 block text-xs font-medium text-slate-600">
                مبلغ احتمالی (ریال)
              </label>
              <Input
                id="opp-amount"
                dir="ltr"
                inputMode="numeric"
                value={form.estimatedAmount}
                onChange={(e) => setForm((f) => ({ ...f, estimatedAmount: e.target.value }))}
              />
            </div>
            <div>
              <label htmlFor="opp-tonnage" className="mb-1 block text-xs font-medium text-slate-600">
                تناژ احتمالی
              </label>
              <Input
                id="opp-tonnage"
                dir="ltr"
                inputMode="decimal"
                value={form.estimatedTonnage}
                onChange={(e) => setForm((f) => ({ ...f, estimatedTonnage: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">تاریخ احتمالی نهایی شدن</span>
            <DatePicker
              value={form.expectedCloseDate}
              onChange={(iso) => setForm((f) => ({ ...f, expectedCloseDate: iso }))}
              aria-label="تاریخ احتمالی نهایی شدن"
            />
          </div>
          {allowedTargets.length > 0 && (
            <div>
              <label htmlFor="opp-status" className="mb-1 block text-xs font-medium text-slate-600">
                تغییر مرحله (اختیاری)
              </label>
              <select
                id="opp-status"
                value={form.status}
                onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as OpportunityStatus | "" }))}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              >
                <option value="">— بدون تغییر —</option>
                {allowedTargets.map((s) => (
                  <option key={s} value={s}>
                    {OPPORTUNITY_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
              {form.status === "LOST" && (
                <div className="mt-2">
                  <label htmlFor="opp-lost-reason" className="mb-1 block text-xs font-medium text-rose-600">
                    دلیل از دست رفتن *
                  </label>
                  <select
                    id="opp-lost-reason"
                    value={form.lostReasonId}
                    onChange={(e) => setForm((f) => ({ ...f, lostReasonId: e.target.value }))}
                    className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    <option value="">انتخاب کنید…</option>
                    {lostReasons.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.nameFa}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
          <div>
            <label htmlFor="opp-desc" className="mb-1 block text-xs font-medium text-slate-600">
              توضیحات
            </label>
            <textarea
              id="opp-desc"
              rows={3}
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}
