"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, jalali } from "@/lib/format";
import {
  ACTIVITY_PRIORITY_CLASSES,
  ACTIVITY_PRIORITY_LABELS,
  ACTIVITY_STATUS_CLASSES,
  ACTIVITY_STATUS_LABELS,
  RELATED_ENTITY_LABELS,
  activityErrorMessage,
  cancelActivity,
  completeActivity,
  createActivity,
  createActivityType,
  fetchActivities,
  fetchActivityTypes,
  updateActivity,
  type ActivityPriority,
  type ActivityRow,
  type ActivityStatus,
  type ActivityTypeRow,
} from "@/lib/activities";

/** فعالیت‌ها (Phase 9A) — فهرست، ایجاد، تکمیل و مدیریت فعالیت‌ها با
 *  فیلتر امروز/عقب‌افتاده/همه. تکمیل فعالیت آن را برای کاربر عادی قفل
 *  می‌کند؛ ویرایش بعدی نیازمند مجوز override و دلیل است. */
export default function ActivitiesPage() {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [types, setTypes] = useState<ActivityTypeRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<"" | ActivityStatus>("");
  const [bucket, setBucket] = useState<"all" | "overdue">("all");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pageSize = 20;

  // create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [typeCode, setTypeCode] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [relatedEntityType, setRelatedEntityType] = useState("party");
  const [relatedEntityId, setRelatedEntityId] = useState("");
  const [assignedToId, setAssignedToId] = useState("");
  const [priority, setPriority] = useState<ActivityPriority>("NORMAL");
  const [dueDate, setDueDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // type management dialog
  const [typesOpen, setTypesOpen] = useState(false);
  const [newTypeCode, setNewTypeCode] = useState("");
  const [newTypeName, setNewTypeName] = useState("");

  // override dialog
  const [overrideTarget, setOverrideTarget] = useState<ActivityRow | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideFields, setOverrideFields] = useState<{ title: string; dueDate: string | null }>({ title: "", dueDate: null });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchActivities({
        status: statusFilter || undefined,
        overdueOnly: bucket === "overdue",
        page,
        pageSize,
      });
      setRows(result.items);
      setTotal(result.total);
    } catch (e) {
      setError(activityErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, bucket]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    fetchActivityTypes()
      .then((t) => {
        setTypes(t);
        if (t.length > 0) setTypeCode((c) => c || t[0].code);
      })
      .catch(() => undefined);
  }, []);

  async function handleCreate() {
    if (!title.trim() || !relatedEntityId.trim()) {
      setError("عنوان و شناسه موجودیت مرتبط الزامی است.");
      return;
    }
    setCreating(true);
    setError(null);
    try {
      await createActivity({
        typeCode,
        title: title.trim(),
        description: description.trim() || undefined,
        relatedEntityType,
        relatedEntityId: relatedEntityId.trim(),
        priority,
        dueDate: dueDate ?? undefined,
      });
      setCreateOpen(false);
      setTitle("");
      setDescription("");
      setRelatedEntityId("");
      setDueDate(null);
      setNotice("فعالیت ساخته شد.");
      await load();
    } catch (e) {
      setError(activityErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  async function handleComplete(row: ActivityRow) {
    setError(null);
    try {
      await completeActivity(row.id);
      setNotice("فعالیت تکمیل شد و در تایم‌لاین موجودیت ثبت شد.");
      await load();
    } catch (e) {
      setError(activityErrorMessage(e));
    }
  }

  async function handleCancel(row: ActivityRow) {
    const reason = prompt("دلیل لغو فعالیت:") ?? "";
    if (!reason.trim()) return;
    setError(null);
    try {
      await cancelActivity(row.id, reason.trim());
      setNotice("فعالیت لغو شد.");
      await load();
    } catch (e) {
      setError(activityErrorMessage(e));
    }
  }

  async function handleOverrideSave() {
    if (!overrideTarget) return;
    if (overrideReason.trim().length < 3) {
      setError("دلیل override الزامی است (حداقل ۳ نویسه).");
      return;
    }
    setError(null);
    try {
      await updateActivity(overrideTarget.id, {
        title: overrideFields.title,
        dueDate: overrideFields.dueDate,
        overrideReason: overrideReason.trim(),
      });
      setOverrideTarget(null);
      setNotice("ویرایش با override ثبت و audit شد.");
      await load();
    } catch (e) {
      setError(activityErrorMessage(e));
    }
  }

  async function handleCreateType() {
    if (!newTypeCode.trim() || !newTypeName.trim()) return;
    setError(null);
    try {
      const t = await createActivityType({ code: newTypeCode.trim(), nameFa: newTypeName.trim() });
      setTypes((prev) => [...prev, t]);
      setTypeCode(t.code);
      setNewTypeCode("");
      setNewTypeName("");
      setNotice("نوع فعالیت جدید ساخته شد.");
    } catch (e) {
      setError(activityErrorMessage(e));
    }
  }

  const columns: DataTableColumn<ActivityRow>[] = [
    {
      key: "title",
      header: "عنوان",
      render: (r) => (
        <div>
          <div className="font-medium">{r.title}</div>
          <div className="text-xs text-slate-500">
            {r.type.nameFa} • {RELATED_ENTITY_LABELS[r.relatedEntityType] ?? r.relatedEntityType}
          </div>
        </div>
      ),
    },
    {
      key: "priority",
      header: "اولویت",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs ${ACTIVITY_PRIORITY_CLASSES[r.priority]}`}>
          {ACTIVITY_PRIORITY_LABELS[r.priority]}
        </span>
      ),
    },
    { key: "dueDate", header: "موعد", render: (r) => (r.dueDate ? jalali(r.dueDate) : "—") },
    {
      key: "status",
      header: "وضعیت",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs ${ACTIVITY_STATUS_CLASSES[r.status]}`}>
          {ACTIVITY_STATUS_LABELS[r.status]}
        </span>
      ),
    },
    {
      key: "overdue",
      header: "عقب‌افتاده",
      render: (r) =>
        r.overdue ? <span className="text-xs font-bold text-red-600">عقب‌افتاده</span> : <span className="text-xs text-slate-400">—</span>,
    },
    {
      key: "assignee",
      header: "مسئول",
      render: (r) =>
        r.assignedTo
          ? `${r.assignedTo.firstName ?? ""} ${r.assignedTo.lastName ?? ""} ${r.assignedTo.username}`.trim()
          : "—",
    },
    {
      key: "actions",
      header: "عملیات",
      render: (r) => (
        <div className="flex gap-1">
          {r.status === "PENDING" && (
            <>
              <Button variant="secondary" onClick={() => void handleComplete(r)}>
                تکمیل
              </Button>
              <Button variant="danger" onClick={() => void handleCancel(r)}>
                لغو
              </Button>
            </>
          )}
          {r.status !== "PENDING" && (
            <Button
              variant="secondary"
              onClick={() => {
                setOverrideTarget(r);
                setOverrideFields({ title: r.title, dueDate: r.dueDate });
                setOverrideReason("");
              }}
            >
              override
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold">فعالیت‌ها</h1>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setTypesOpen(true)}>
            انواع فعالیت
          </Button>
          <Button onClick={() => setCreateOpen(true)}>فعالیت جدید</Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={bucket}
          onChange={(e) => {
            setBucket(e.target.value as "all" | "overdue");
            setPage(1);
          }}
          className="h-9 rounded-md border border-slate-300 bg-white px-2"
        >
          <option value="all">همه</option>
          <option value="overdue">عقب‌افتاده</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value as "" | ActivityStatus);
            setPage(1);
          }}
          className="h-9 rounded-md border border-slate-300 bg-white px-2"
        >
          <option value="">همه وضعیت‌ها</option>
          <option value="PENDING">در جریان</option>
          <option value="COMPLETED">تکمیل‌شده</option>
          <option value="CANCELLED">لغو‌شده</option>
        </select>
        <span className="text-slate-500">{faDigits(total)} مورد</span>
      </div>

      {error && <div className="rounded-md border border-red-300 bg-red-50 p-2 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-700">{notice}</div>}

      <DataTable
        rowKey={(r) => r.id}
        columns={columns}
        rows={rows}
        loading={loading}
        emptyMessage="فعالیتی یافت نشد."
      />

      <div className="flex items-center gap-2 text-sm">
        <Button variant="secondary" disabled={page <= 1 || loading} onClick={() => setPage((p) => Math.max(1, p - 1))}>
          قبلی
        </Button>
        <span>صفحه {faDigits(page)}</span>
        <Button
          variant="secondary"
          disabled={page * pageSize >= total || loading}
          onClick={() => setPage((p) => p + 1)}
        >
          بعدی
        </Button>
      </div>

      {/* create dialog */}
      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="فعالیت جدید">
        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs text-slate-500">نوع</label>
            <select value={typeCode} onChange={(e) => setTypeCode(e.target.value)} className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
              {types.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.nameFa}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">عنوان</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">شرح</label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs text-slate-500">نوع موجودیت</label>
              <select
                value={relatedEntityType}
                onChange={(e) => setRelatedEntityType(e.target.value)}
                className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
              >
                {Object.entries(RELATED_ENTITY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">شناسه موجودیت (UUID)</label>
              <Input value={relatedEntityId} onChange={(e) => setRelatedEntityId(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">اولویت</label>
              <select value={priority} onChange={(e) => setPriority(e.target.value as ActivityPriority)} className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm">
                {Object.entries(ACTIVITY_PRIORITY_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <span className="mb-1 block text-xs text-slate-500">موعد</span>
              <JalaliDateInput value={dueDate} onChange={setDueDate} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>
              انصراف
            </Button>
            <Button disabled={creating} onClick={() => void handleCreate()}>
              {creating ? "در حال ثبت…" : "ثبت"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* type management dialog */}
      <Modal open={typesOpen} onClose={() => setTypesOpen(false)} title="انواع فعالیت">
        <div className="space-y-3">
          <ul className="divide-y divide-slate-100 text-sm">
            {types.map((t) => (
              <li key={t.id} className="py-1">
                {t.nameFa} <span className="text-xs text-slate-400">({t.code})</span>
              </li>
            ))}
          </ul>
          <div className="flex items-end gap-2">
            <div>
              <label className="mb-1 block text-xs text-slate-500">کد</label>
              <Input value={newTypeCode} onChange={(e) => setNewTypeCode(e.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">نام فارسی</label>
              <Input value={newTypeName} onChange={(e) => setNewTypeName(e.target.value)} />
            </div>
            <Button variant="secondary" onClick={() => void handleCreateType()}>
              افزودن
            </Button>
          </div>
        </div>
      </Modal>

      {/* override dialog */}
      <Modal open={!!overrideTarget} onClose={() => setOverrideTarget(null)} title="Override فعالیت تکمیل‌شده">
        <div className="space-y-3">
          <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
            این فعالیت تکمیل شده است. ویرایش نیازمند مجوز override است، دلیل الزامی است و در audit ثبت می‌شود.
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">عنوان جدید</label>
            <Input value={overrideFields.title} onChange={(e) => setOverrideFields((f) => ({ ...f, title: e.target.value }))} />
          </div>
          <div>
            <span className="mb-1 block text-xs text-slate-500">موعد جدید</span>
            <JalaliDateInput
              value={overrideFields.dueDate}
              onChange={(d) => setOverrideFields((f) => ({ ...f, dueDate: d }))}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">دلیل override (الزامی)</label>
            <Input value={overrideReason} onChange={(e) => setOverrideReason(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOverrideTarget(null)}>
              انصراف
            </Button>
            <Button onClick={() => void handleOverrideSave()}>ثبت override</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
