"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalaliDateTime } from "@/lib/format";
import { apiJson } from "@/lib/api";

interface ApprovalRow {
  id: string;
  companyId: string;
  entityType: string;
  entityId: string;
  approvalType: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reason: string | null;
  source: string;
  dueAt: string | null;
  escalationLevel: number;
  createdAt: string;
}

interface ApprovalEventRow {
  id: string;
  kind: string;
  note: string | null;
  createdAt: string;
  actorUserId: string | null;
}

const STATUS_LABELS: Record<ApprovalRow["status"], string> = {
  PENDING: "در انتظار",
  APPROVED: "تأییدشده",
  REJECTED: "ردشده",
  CANCELLED: "لغوشده",
};

const STATUS_BADGES: Record<ApprovalRow["status"], string> = {
  PENDING: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-rose-100 text-rose-800",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const TYPE_LABELS: Record<string, string> = {
  RELEASE_DRIVER_INFO: "افشای اطلاعات راننده",
};

const EVENT_LABELS: Record<string, string> = {
  REQUESTED: "ثبت درخواست",
  DECIDED: "تصمیم",
  CANCELLED: "لغو",
  ESCALATED: "ارجاع (escalation)",
};

function entityHref(row: ApprovalRow): string | null {
  if (row.entityType === "loading") return `/loadings/${row.entityId}`;
  if (row.entityType === "workflow_instance") return `/workflow`;
  return null;
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 20;

  // decision note modal
  const [decideTarget, setDecideTarget] = useState<{ id: string; decision: "APPROVED" | "REJECTED" } | null>(null);
  const [note, setNote] = useState("");

  // history modal
  const [history, setHistory] = useState<{ id: string; events: ApprovalEventRow[] } | null>(null);

  // create panel
  const [createOpen, setCreateOpen] = useState(false);
  const [newEntityType, setNewEntityType] = useState("loading");
  const [newEntityId, setNewEntityId] = useState("");
  const [newType, setNewType] = useState("");
  const [newReason, setNewReason] = useState("");
  const [newDueAt, setNewDueAt] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (status) params.set("status", status);
      const res = await apiJson<{ items: ApprovalRow[]; total: number }>(`/approvals?${params.toString()}`);
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitDecision = async () => {
    if (!decideTarget) return;
    setBusyId(decideTarget.id);
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/approvals/${decideTarget.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision: decideTarget.decision, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      setDecideTarget(null);
      setNote("");
      setNotice("تصمیم ثبت شد.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (id: string) => {
    setBusyId(id);
    setError(null);
    setNotice(null);
    try {
      await apiJson(`/approvals/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "لغو توسط کاربر" }),
      });
      setNotice("درخواست لغو شد.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const openHistory = async (id: string) => {
    setError(null);
    try {
      const d = await apiJson<ApprovalRow & { events: ApprovalEventRow[] }>(`/approvals/${id}`);
      setHistory({ id, events: d.events ?? [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const create = async () => {
    setBusyId("create");
    setError(null);
    setNotice(null);
    try {
      await apiJson("/approvals", {
        method: "POST",
        body: JSON.stringify({
          entityType: newEntityType,
          entityId: newEntityId.trim(),
          approvalType: newType.trim(),
          ...(newReason.trim() ? { reason: newReason.trim() } : {}),
          ...(newDueAt ? { dueAt: new Date(newDueAt).toISOString() } : {}),
        }),
      });
      setCreateOpen(false);
      setNewEntityId("");
      setNewType("");
      setNewReason("");
      setNewDueAt("");
      setNotice("درخواست تأیید ثبت شد.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns: DataTableColumn<ApprovalRow>[] = [
    {
      key: "type",
      header: "نوع",
      render: (r) => (
        <span className="text-sm text-slate-800">
          {TYPE_LABELS[r.approvalType] ?? r.approvalType}
          {r.source === "WORKFLOW" && <span className="ms-1 rounded bg-sky-50 px-1 text-[10px] text-sky-700">گردش کار</span>}
        </span>
      ),
    },
    {
      key: "entity",
      header: "مرجع",
      render: (r) => {
        const href = entityHref(r);
        return href ? (
          <Link href={href} className="text-xs text-sky-700 hover:underline">
            باز کردن سند
          </Link>
        ) : (
          <span className="text-xs text-slate-400">{r.entityType}</span>
        );
      },
    },
    {
      key: "createdAt",
      header: "تاریخ درخواست",
      render: (r) => <span className="text-xs tabular-nums text-slate-700">{jalaliDateTime(r.createdAt)}</span>,
    },
    {
      key: "due",
      header: "مهلت",
      render: (r) =>
        r.dueAt ? (
          <span className="text-xs tabular-nums text-slate-600">
            {jalaliDateTime(r.dueAt)}
            {r.escalationLevel > 0 && <span className="ms-1 text-rose-600">ارجاع ×{faDigits(r.escalationLevel)}</span>}
          </span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGES[r.status]}`}>
          {STATUS_LABELS[r.status]}
        </span>
      ),
    },
    {
      key: "actions",
      header: "اقدام",
      align: "center",
      render: (r) =>
        r.status === "PENDING" ? (
          <div className="flex justify-center gap-1">
            <Button
              variant="primary"
              disabled={busyId === r.id}
              onClick={() => {
                setNote("");
                setDecideTarget({ id: r.id, decision: "APPROVED" });
              }}
            >
              تأیید
            </Button>
            <Button
              variant="danger"
              disabled={busyId === r.id}
              onClick={() => {
                setNote("");
                setDecideTarget({ id: r.id, decision: "REJECTED" });
              }}
            >
              رد
            </Button>
            <Button variant="ghost" disabled={busyId === r.id} onClick={() => void cancel(r.id)}>
              لغو
            </Button>
          </div>
        ) : (
          <div className="flex justify-center">
            <Button variant="ghost" onClick={() => void openHistory(r.id)}>
              تاریخچه
            </Button>
          </div>
        ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-800">تأییدها</h1>
        <Button variant="primary" onClick={() => setCreateOpen(true)}>
          درخواست جدید
        </Button>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <div className="flex items-center gap-2">
        <select
          className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
          value={status}
          onChange={(e) => {
            setPage(1);
            setStatus(e.target.value);
          }}
        >
          <option value="">همه وضعیت‌ها</option>
          {Object.entries(STATUS_LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="درخواست تأییدی وجود ندارد"
      />
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>
          مجموع {faDigits(total)} — صفحه {faDigits(page)} از {faDigits(totalPages)}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            قبلی
          </Button>
          <Button variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            بعدی
          </Button>
        </div>
      </div>

      {/* decision note modal */}
      <Modal
        open={decideTarget !== null}
        title={decideTarget?.decision === "APPROVED" ? "تأیید درخواست" : "رد درخواست"}
        onClose={() => setDecideTarget(null)}
        small
      >
        <div className="space-y-3">
          <label className="block text-xs text-slate-600">
            یادداشت تصمیم (اختیاری)
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDecideTarget(null)}>
              انصراف
            </Button>
            <Button
              variant={decideTarget?.decision === "APPROVED" ? "primary" : "danger"}
              disabled={busyId !== null}
              onClick={() => void submitDecision()}
            >
              {busyId ? "…" : decideTarget?.decision === "APPROVED" ? "تأیید نهایی" : "رد نهایی"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* history modal */}
      <Modal open={history !== null} title="تاریخچه درخواست" onClose={() => setHistory(null)} small>
        {history && (
          <ol className="space-y-2">
            {history.events.length === 0 && <li className="text-xs text-slate-500">رویدادی ثبت نشده است.</li>}
            {history.events.map((ev) => (
              <li key={ev.id} className="flex items-baseline gap-2 text-xs">
                <span className="tabular-nums text-slate-400">{jalaliDateTime(ev.createdAt)}</span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">
                  {EVENT_LABELS[ev.kind] ?? ev.kind}
                </span>
                <span className="text-slate-600">{ev.note ?? ""}</span>
              </li>
            ))}
          </ol>
        )}
      </Modal>

      {/* create modal */}
      <Modal open={createOpen} title="درخواست تأیید جدید" onClose={() => setCreateOpen(false)}>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              نوع موجودیت
              <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={newEntityType} onChange={(e) => setNewEntityType(e.target.value)}>
                <option value="loading">بارگیری</option>
                <option value="goods_receipt">رسید انبار</option>
              </select>
            </label>
            <label className="text-xs text-slate-600">
              شناسه موجودیت (UUID)
              <Input value={newEntityId} onChange={(e) => setNewEntityId(e.target.value)} dir="ltr" />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              نوع تأیید
              <Input value={newType} onChange={(e) => setNewType(e.target.value)} placeholder="RELEASE_DRIVER_INFO" dir="ltr" />
            </label>
            <label className="text-xs text-slate-600">
              مهلت تصمیم (اختیاری)
              <Input type="datetime-local" value={newDueAt} onChange={(e) => setNewDueAt(e.target.value)} />
            </label>
          </div>
          <label className="block text-xs text-slate-600">
            دلیل درخواست
            <textarea className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm" rows={2} value={newReason} onChange={(e) => setNewReason(e.target.value)} />
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              انصراف
            </Button>
            <Button variant="primary" disabled={busyId !== null || !newEntityId.trim() || !newType.trim()} onClick={() => void create()}>
              {busyId === "create" ? "…" : "ثبت درخواست"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
