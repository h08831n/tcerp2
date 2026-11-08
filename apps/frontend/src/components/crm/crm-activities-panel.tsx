"use client";

/**
 * CR-001 §5 — THE shared CRM activities panel (Lead + Opportunity detail).
 *
 * Reuses the GENERIC activities machinery (relatedEntityType/relatedEntityId)
 * — the SAME system every party entity uses; no parallel history. Sections:
 * عقب‌افتاده / برنامه‌ریزی‌شده / تاریخچه — mirroring the Odoo activity chip.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DateTimePicker } from "@/components/ui/date-time-picker";
import { useAuth } from "@/lib/auth-context";
import {
  activityErrorMessage,
  cancelActivity,
  completeActivity,
  createActivity,
  fetchActivities,
  fetchActivityTypes,
  type ActivityRow,
  type ActivityTypeRow,
} from "@/lib/activities";
import { jalaliDateTime } from "@/lib/format";

export interface CrmActivitiesPanelProps {
  relatedEntityType: "lead" | "opportunity" | "party";
  relatedEntityId: string;
  /** Bump to force a reload after sibling mutations. */
  refreshToken?: number;
}

export function CrmActivitiesPanel({ relatedEntityType, relatedEntityId, refreshToken = 0 }: CrmActivitiesPanelProps) {
  const { permissions } = useAuth();
  const canCreate = permissions.includes("activities.create");
  const canEdit = permissions.includes("activities.edit");

  const [items, setItems] = useState<ActivityRow[] | null>(null);
  const [types, setTypes] = useState<ActivityTypeRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [typeCode, setTypeCode] = useState("");
  const [due, setDue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [busyId, setBusyId] = useState<string | null>(null);
  const [completing, setCompleting] = useState<ActivityRow | null>(null);
  const [completeNote, setCompleteNote] = useState("");
  // R2 §4: «انجام شد و برنامه‌ریزی فعالیت بعدی» — optionally schedule the
  // next follow-up in the SAME dialog (Odoo's Open + Schedule next).
  const [nextTitle, setNextTitle] = useState("");
  const [nextTypeCode, setNextTypeCode] = useState("");
  const [nextDue, setNextDue] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<ActivityRow | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      fetchActivities({ relatedEntityType, relatedEntityId, pageSize: 100 }),
      fetchActivityTypes(),
    ])
      .then(([acts, tps]) => {
        if (cancelled) return;
        setItems(acts.items);
        setTypes(tps); // fetchActivityTypes returns ACTIVE types only
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(activityErrorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [relatedEntityType, relatedEntityId]);

  useEffect(() => load(), [load, reloadToken, refreshToken]);

  const now = Date.now();
  const pending = (items ?? []).filter((a) => a.status === "PENDING");
  const overdue = pending.filter((a) => a.dueDate && new Date(a.dueDate).getTime() < now);
  const upcoming = pending.filter((a) => !a.dueDate || new Date(a.dueDate).getTime() >= now);
  const history = (items ?? []).filter((a) => a.status !== "PENDING");

  async function handleCreate() {
    if (title.trim().length < 2) {
      setFormError("عنوان فعالیت الزامی است (حداقل ۲ نویسه).");
      return;
    }
    if (!typeCode) {
      setFormError("نوع فعالیت را انتخاب کنید.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await createActivity({
        typeCode,
        title: title.trim(),
        description: description.trim() || undefined,
        relatedEntityType,
        relatedEntityId,
        ...(due ? { dueDate: due } : {}),
      });
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setDue(null);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setFormError(activityErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleComplete() {
    if (!completing) return;
    setBusyId(completing.id);
    try {
      await completeActivity(completing.id, completeNote.trim() || undefined);
      // R2 §4: schedule the NEXT activity (same related entity) right after
      // the completion — «انجام شد + فعالیت بعدی».
      const wantsNext = nextTitle.trim().length >= 2;
      if (wantsNext) {
        try {
          await createActivity({
            typeCode: nextTypeCode || types[0]?.code || "",
            title: nextTitle.trim(),
            relatedEntityType,
            relatedEntityId,
            ...(nextDue ? { dueDate: nextDue } : {}),
          });
        } catch (nextErr) {
          // The completion itself SUCCEEDED — surface the follow-up failure
          // without rolling back the done state.
          setError(activityErrorMessage(nextErr));
        }
      }
      setCompleting(null);
      setCompleteNote("");
      setNextTitle("");
      setNextTypeCode("");
      setNextDue(null);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(activityErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel() {
    if (!cancelling) return;
    setBusyId(cancelling.id);
    try {
      await cancelActivity(cancelling.id, cancelReason.trim() || "لغو توسط کاربر");
      setCancelling(null);
      setCancelReason("");
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(activityErrorMessage(err));
    } finally {
      setBusyId(null);
    }
  }

  function row(a: ActivityRow, tone: "rose" | "slate") {
    return (
      <li
        key={a.id}
        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 ${
          tone === "rose" ? "border-rose-200 bg-rose-50" : "border-slate-200 bg-white"
        }`}
      >
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-800">{a.title}</p>
          <p className="text-[11px] text-slate-500">
            {a.type?.nameFa ?? ""} ·
            {a.dueDate ? (
              <span className={tone === "rose" ? "font-medium text-rose-600" : ""}> موعد: {jalaliDateTime(a.dueDate)}</span>
            ) : (
              " بدون موعد"
            )}
          </p>
        </div>
        {canEdit && a.status === "PENDING" && (
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" onClick={() => setCompleting(a)} disabled={busyId === a.id}>
              تکمیل
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCancelling(a)} disabled={busyId === a.id}>
              لغو
            </Button>
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label="فعالیت‌ها و پیگیری‌ها">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">فعالیت‌ها و پیگیری‌ها</h3>
        {canCreate && (
          <Button
            size="sm"
            onClick={() => {
              setCreateOpen(true);
              setTypeCode(types[0]?.code ?? "");
            }}
          >
            فعالیت جدید
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {items === null ? (
        <p className="text-xs text-slate-400">در حال بارگذاری…</p>
      ) : (
        <div className="space-y-3">
          {overdue.length > 0 && (
            <div>
              <p className="mb-1 text-xs font-medium text-rose-600">عقب‌افتاده ({overdue.length})</p>
              <ul className="space-y-1.5">{overdue.map((a) => row(a, "rose"))}</ul>
            </div>
          )}
          <div>
            <p className="mb-1 text-xs font-medium text-slate-600">برنامه‌ریزی‌شده ({upcoming.length})</p>
            {upcoming.length === 0 ? (
              <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
                فعالیتی برنامه‌ریزی نشده است.
              </p>
            ) : (
              <ul className="space-y-1.5">{upcoming.map((a) => row(a, "slate"))}</ul>
            )}
          </div>
          {history.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs font-medium text-slate-600">
                تاریخچه انجام‌شده/لغوشده ({history.length})
              </summary>
              <ul className="mt-1.5 space-y-1.5">
                {history.map((a) => (
                  <li key={a.id} className="rounded-md border border-slate-100 bg-slate-50 px-3 py-1.5">
                    <p className="text-xs text-slate-600">
                      {a.title} — <span className="text-slate-400">{a.status === "COMPLETED" ? "انجام‌شده" : "لغوشده"}</span>
                      {a.completedAt ? ` · ${jalaliDateTime(a.completedAt)}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Create */}
      <Modal
        open={createOpen}
        title="ثبت فعالیت جدید"
        onClose={() => setCreateOpen(false)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={saving}>
              {saving ? "در حال ثبت…" : "ثبت"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {formError}
            </div>
          )}
          <div>
            <label htmlFor="crm-act-type" className="mb-1 block text-xs font-medium text-slate-600">
              نوع فعالیت *
            </label>
            <select
              id="crm-act-type"
              value={typeCode}
              onChange={(e) => setTypeCode(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">انتخاب کنید…</option>
              {types.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.nameFa}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="crm-act-title" className="mb-1 block text-xs font-medium text-slate-600">
              عنوان *
            </label>
            <Input id="crm-act-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label htmlFor="crm-act-desc" className="mb-1 block text-xs font-medium text-slate-600">
              توضیح
            </label>
            <textarea
              id="crm-act-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">موعد (تاریخ و ساعت)</span>
            <DateTimePicker value={due} onChange={setDue} aria-label="موعد فعالیت" />
          </div>
        </div>
      </Modal>

      {/* Complete */}
      <Modal
        open={completing !== null}
        title={`تکمیل فعالیت: ${completing?.title ?? ""}`}
        onClose={() => setCompleting(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCompleting(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleComplete()} disabled={busyId !== null}>
              تکمیل
            </Button>
          </>
        }
      >
        <label htmlFor="crm-act-note" className="mb-1 block text-xs font-medium text-slate-600">
          نتیجه / یادداشت تکمیل (اختیاری)
        </label>
        <textarea
          id="crm-act-note"
          rows={2}
          value={completeNote}
          onChange={(e) => setCompleteNote(e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        />
        <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-2">
          <p className="mb-1.5 text-[11px] font-medium text-slate-600">
            برنامه‌ریزی فعالیت بعدی (اختیاری — «انجام شد + فعالیت بعدی»)
          </p>
          <div className="space-y-2">
            <Input
              value={nextTitle}
              onChange={(e) => setNextTitle(e.target.value)}
              placeholder="عنوان فعالیت بعدی…"
              aria-label="عنوان فعالیت بعدی"
            />
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={nextTypeCode}
                onChange={(e) => setNextTypeCode(e.target.value)}
                aria-label="نوع فعالیت بعدی"
                className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-xs"
              >
                <option value="">نوع…</option>
                {types.map((t) => (
                  <option key={t.code} value={t.code}>
                    {t.nameFa}
                  </option>
                ))}
              </select>
              <DateTimePicker value={nextDue} onChange={setNextDue} aria-label="موعد فعالیت بعدی" />
            </div>
          </div>
        </div>
      </Modal>

      {/* Cancel */}
      <Modal
        open={cancelling !== null}
        title={`لغو فعالیت: ${cancelling?.title ?? ""}`}
        onClose={() => setCancelling(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCancelling(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" variant="danger" onClick={() => void handleCancel()} disabled={busyId !== null}>
              لغو فعالیت
            </Button>
          </>
        }
      >
        <label htmlFor="crm-act-reason" className="mb-1 block text-xs font-medium text-slate-600">
          دلیل لغو *
        </label>
        <Input id="crm-act-reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
      </Modal>
    </section>
  );
}

export default CrmActivitiesPanel;
