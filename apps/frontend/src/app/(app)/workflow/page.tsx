"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalaliDateTime } from "@/lib/format";
import { apiJson } from "@/lib/api";

// ───────────────────────────── types ─────────────────────────────

interface WorkflowStateRow {
  id: string;
  code: string;
  name: string;
  isInitial: boolean;
  isFinal: boolean;
  slaHours: number | null;
}

interface WorkflowTransitionRow {
  id: string;
  code: string;
  name: string;
  fromStateId: string;
  toStateId: string;
  requiredPermission: string | null;
  requiresApproval: boolean;
  slaHours: number | null;
}

interface Definition {
  id: string;
  code: string;
  name: string;
  entityType: string;
  isActive: boolean;
  _count?: { instances: number };
  states?: WorkflowStateRow[];
  transitions?: WorkflowTransitionRow[];
}

interface InstanceRow {
  id: string;
  definitionId: string;
  currentStateId: string | null;
  entityType: string;
  entityId: string;
  status: "ACTIVE" | "COMPLETED" | "CANCELLED";
  version: number;
  createdAt: string;
  definition: { code: string; name: string };
  currentState: { code: string; name: string } | null;
}

interface LogRow {
  id: string;
  kind: string;
  note: string | null;
  createdAt: string;
  actorUserId: string | null;
  transition: { code: string; name: string } | null;
}

interface InstanceDetail extends InstanceRow {
  states?: WorkflowStateRow[];
  transitions?: WorkflowTransitionRow[];
  logs: LogRow[];
  approvals: Array<{ id: string; approvalType: string; status: string; escalationLevel: number }>;
}

const ENTITY_LABELS: Record<string, string> = {
  loading: "بارگیری",
  goods_receipt: "رسید انبار",
  sales_document: "سند فروش",
  purchase_document: "سند خرید",
};

const STATUS_LABELS: Record<InstanceRow["status"], string> = {
  ACTIVE: "فعال",
  COMPLETED: "تکمیل‌شده",
  CANCELLED: "لغوشده",
};

const STATUS_BADGES: Record<InstanceRow["status"], string> = {
  ACTIVE: "bg-sky-100 text-sky-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const LOG_KIND_LABELS: Record<string, string> = {
  STARTED: "شروع",
  TRANSITION: "انتقال",
  APPROVAL_REQUESTED: "درخواست تایید",
  APPROVAL_DECIDED: "تصمیم تایید",
  TIMER_FIRED: "زمان‌سنج",
  CANCELLED: "لغو",
  FAILED: "خطا",
};

interface StateDraft {
  code: string;
  name: string;
  isInitial: boolean;
  isFinal: boolean;
  slaHours: string;
}

interface TransitionDraft {
  code: string;
  name: string;
  fromState: string;
  toState: string;
  requiresApproval: boolean;
  approvalType: string;
  slaHours: string;
  requiredPermission: string;
  conditionJson: string;
}

const emptyState = (): StateDraft => ({ code: "", name: "", isInitial: false, isFinal: false, slaHours: "" });
const emptyTransition = (): TransitionDraft => ({
  code: "", name: "", fromState: "", toState: "", requiresApproval: false,
  approvalType: "", slaHours: "", requiredPermission: "", conditionJson: "",
});

export default function WorkflowPage() {
  const [definitions, setDefinitions] = useState<Definition[]>([]);
  const [instances, setInstances] = useState<InstanceRow[]>([]);
  const [instanceTotal, setInstanceTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 15;

  // create-definition modal
  const [createOpen, setCreateOpen] = useState(false);
  const [defCode, setDefCode] = useState("");
  const [defName, setDefName] = useState("");
  const [defEntity, setDefEntity] = useState("loading");
  const [states, setStates] = useState<StateDraft[]>([{ ...emptyState(), isInitial: true }, { ...emptyState(), isFinal: true }]);
  const [transitions, setTransitions] = useState<TransitionDraft[]>([{ ...emptyTransition() }]);
  const [busy, setBusy] = useState(false);

  // instance detail modal
  const [detail, setDetail] = useState<InstanceDetail | null>(null);

  // start-instance modal
  const [startOpen, setStartOpen] = useState(false);
  const [startCode, setStartCode] = useState("");
  const [startEntity, setStartEntity] = useState("loading");
  const [startEntityId, setStartEntityId] = useState("");
  const [startContext, setStartContext] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [defs, inst] = await Promise.all([
        apiJson<Definition[]>("/workflow/definitions"),
        apiJson<{ items: InstanceRow[]; total: number }>(`/workflow/instances?page=${page}&pageSize=${pageSize}`),
      ]);
      setDefinitions(defs);
      setInstances(inst.items);
      setInstanceTotal(inst.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (id: string) => {
    setError(null);
    try {
      const d = await apiJson<InstanceDetail>(`/workflow/instances/${id}`);
      setDetail(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // ───────────────────── create definition ─────────────────────

  const createDefinition = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const conditionOf = (t: TransitionDraft): unknown => {
        if (!t.conditionJson.trim()) return undefined;
        return JSON.parse(t.conditionJson);
      };
      await apiJson("/workflow/definitions", {
        method: "POST",
        body: JSON.stringify({
          code: defCode.trim(),
          name: defName.trim(),
          entityType: defEntity,
          states: states
            .filter((s) => s.code.trim() && s.name.trim())
            .map((s) => ({
              code: s.code.trim(),
              name: s.name.trim(),
              isInitial: s.isInitial,
              isFinal: s.isFinal,
              ...(s.slaHours ? { slaHours: Number(s.slaHours) } : {}),
            })),
          transitions: transitions
            .filter((t) => t.code.trim() && t.fromState && t.toState)
            .map((t) => ({
              code: t.code.trim(),
              name: t.name.trim() || t.code.trim(),
              fromState: t.fromState,
              toState: t.toState,
              requiresApproval: t.requiresApproval,
              ...(t.requiresApproval && t.approvalType.trim() ? { approvalType: t.approvalType.trim() } : {}),
              ...(t.slaHours ? { slaHours: Number(t.slaHours) } : {}),
              ...(t.requiredPermission.trim() ? { requiredPermission: t.requiredPermission.trim() } : {}),
              ...(conditionOf(t) !== undefined ? { condition: conditionOf(t) } : {}),
            })),
        }),
      });
      setCreateOpen(false);
      setDefCode("");
      setDefName("");
      setStates([{ ...emptyState(), isInitial: true }, { ...emptyState(), isFinal: true }]);
      setTransitions([{ ...emptyTransition() }]);
      setNotice("تعریف گردش کار ساخته شد.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ───────────────────── start instance ─────────────────────

  const startInstance = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let context: unknown;
      if (startContext.trim()) context = JSON.parse(startContext);
      await apiJson("/workflow/instances", {
        method: "POST",
        body: JSON.stringify({
          definitionCode: startCode.trim(),
          entityType: startEntity,
          entityId: startEntityId.trim(),
          ...(context !== undefined ? { context } : {}),
        }),
      });
      setStartOpen(false);
      setStartEntityId("");
      setStartContext("");
      setNotice("نمونه گردش کار شروع شد.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ───────────────────── instance actions ─────────────────────

  const availableTransitions = useMemo(() => {
    if (!detail) return [];
    const current = detail.currentStateId;
    return (detail.transitions ?? []).filter((t) => t.fromStateId === current);
  }, [detail]);

  const executeTransition = async (code: string) => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiJson<{ outcome: string }>(`/workflow/instances/${detail.id}/transition`, {
        method: "POST",
        body: JSON.stringify({ transitionCode: code }),
      });
      setNotice(
        res.outcome === "APPROVAL_REQUESTED"
          ? "انتقال نیازمند تایید است — درخواست ثبت شد."
          : "انتقال اجرا شد.",
      );
      await openDetail(detail.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelInstance = async () => {
    if (!detail) return;
    setBusy(true);
    setError(null);
    try {
      await apiJson(`/workflow/instances/${detail.id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ reason: "لغو از صفحه گردش کار" }),
      });
      setNotice("نمونه لغو شد.");
      await openDetail(detail.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // ───────────────────── table columns ─────────────────────

  const defColumns: DataTableColumn<Definition>[] = [
    { key: "code", header: "کد", render: (d) => <span className="font-mono text-xs">{d.code}</span> },
    { key: "name", header: "نام", render: (d) => <span className="text-sm">{d.name}</span> },
    { key: "entity", header: "موجودیت", render: (d) => <span className="text-xs">{ENTITY_LABELS[d.entityType] ?? d.entityType}</span> },
    {
      key: "count",
      header: "نمونه‌ها",
      align: "center",
      render: (d) => <span className="text-xs tabular-nums">{faDigits(d._count?.instances ?? 0)}</span>,
    },
    {
      key: "active",
      header: "وضعیت",
      align: "center",
      render: (d) =>
        d.isActive ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">فعال</span>
        ) : (
          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">غیرفعال</span>
        ),
    },
  ];

  const instanceColumns: DataTableColumn<InstanceRow>[] = [
    { key: "def", header: "گردش کار", render: (r) => <span className="text-sm">{r.definition.name}</span> },
    {
      key: "entity",
      header: "موجودیت",
      render: (r) => <span className="text-xs text-slate-600">{ENTITY_LABELS[r.entityType] ?? r.entityType}</span>,
    },
    { key: "state", header: "مرحله", render: (r) => <span className="text-xs">{r.currentState?.name ?? "—"}</span> },
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
    { key: "created", header: "شروع", render: (r) => <span className="text-xs tabular-nums text-slate-600">{jalaliDateTime(r.createdAt)}</span> },
    {
      key: "open",
      header: "جزئیات",
      align: "center",
      render: (r) => (
        <Button variant="ghost" onClick={() => void openDetail(r.id)}>
          مشاهده
        </Button>
      ),
    },
  ];

  const instanceTotalPages = Math.max(1, Math.ceil(instanceTotal / pageSize));

  // ───────────────────── render ─────────────────────

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold text-slate-800">گردش کار</h1>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setStartOpen(true)}>
            شروع نمونه
          </Button>
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            تعریف جدید
          </Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <section className="space-y-2">
        <h2 className="text-sm font-bold text-slate-700">تعریف‌ها</h2>
        <DataTable columns={defColumns} rows={definitions} rowKey={(d) => d.id} loading={loading} emptyMessage="تعریفی وجود ندارد" />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-bold text-slate-700">نمونه‌های در حال اجرا</h2>
        <DataTable columns={instanceColumns} rows={instances} rowKey={(r) => r.id} loading={loading} emptyMessage="نمونه‌ای وجود ندارد" />
        <div className="flex items-center justify-between text-xs text-slate-600">
          <span>
            مجموع {faDigits(instanceTotal)} — صفحه {faDigits(page)} از {faDigits(instanceTotalPages)}
          </span>
          <div className="flex gap-2">
            <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              قبلی
            </Button>
            <Button variant="ghost" disabled={page >= instanceTotalPages} onClick={() => setPage((p) => p + 1)}>
              بعدی
            </Button>
          </div>
        </div>
      </section>

      {/* ── create definition modal ── */}
      <Modal open={createOpen} title="تعریف گردش کار جدید" onClose={() => setCreateOpen(false)}>
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <label className="text-xs text-slate-600">
              کد
              <Input value={defCode} onChange={(e) => setDefCode(e.target.value)} placeholder="SALES_APPROVAL" />
            </label>
            <label className="text-xs text-slate-600">
              نام
              <Input value={defName} onChange={(e) => setDefName(e.target.value)} placeholder="تایید فروش بزرگ" />
            </label>
            <label className="text-xs text-slate-600">
              موجودیت
              <select
                className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
                value={defEntity}
                onChange={(e) => setDefEntity(e.target.value)}
              >
                {Object.entries(ENTITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-700">مرحله‌ها</h3>
              <Button variant="ghost" onClick={() => setStates((s) => [...s, emptyState()])}>
                + مرحله
              </Button>
            </div>
            {states.map((s, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_auto_auto_auto_auto] items-center gap-2 rounded border border-slate-200 p-2">
                <Input placeholder="کد (NEW)" value={s.code} onChange={(e) => setStates((arr) => arr.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
                <Input placeholder="نام" value={s.name} onChange={(e) => setStates((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                <label className="flex items-center gap-1 text-[11px] text-slate-600">
                  <input type="checkbox" checked={s.isInitial} onChange={(e) => setStates((arr) => arr.map((x, j) => (j === i ? { ...x, isInitial: e.target.checked, isFinal: e.target.checked ? false : x.isFinal } : x)))} />
                  شروع
                </label>
                <label className="flex items-center gap-1 text-[11px] text-slate-600">
                  <input type="checkbox" checked={s.isFinal} onChange={(e) => setStates((arr) => arr.map((x, j) => (j === i ? { ...x, isFinal: e.target.checked, isInitial: e.target.checked ? false : x.isInitial } : x)))} />
                  پایان
                </label>
                <Input placeholder="SLA ساعت" value={s.slaHours} onChange={(e) => setStates((arr) => arr.map((x, j) => (j === i ? { ...x, slaHours: e.target.value } : x)))} className="w-20" />
                <Button variant="danger" onClick={() => setStates((arr) => arr.filter((_, j) => j !== i))}>
                  ×
                </Button>
              </div>
            ))}
          </div>

          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-700">انتقال‌ها</h3>
              <Button variant="ghost" onClick={() => setTransitions((t) => [...t, emptyTransition()])}>
                + انتقال
              </Button>
            </div>
            {transitions.map((t, i) => (
              <div key={i} className="space-y-1 rounded border border-slate-200 p-2">
                <div className="grid grid-cols-[1fr_1fr_auto_auto_auto_auto] items-center gap-2">
                  <Input placeholder="کد" value={t.code} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} />
                  <Input placeholder="نام" value={t.name} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <select className="rounded-md border border-slate-300 px-1 py-1 text-xs" value={t.fromState} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, fromState: e.target.value } : x)))}>
                    <option value="">از…</option>
                    {states.filter((s) => s.code).map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code}
                      </option>
                    ))}
                  </select>
                  <select className="rounded-md border border-slate-300 px-1 py-1 text-xs" value={t.toState} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, toState: e.target.value } : x)))}>
                    <option value="">به…</option>
                    {states.filter((s) => s.code).map((s) => (
                      <option key={s.code} value={s.code}>
                        {s.code}
                      </option>
                    ))}
                  </select>
                  <label className="flex items-center gap-1 text-[11px] text-slate-600">
                    <input type="checkbox" checked={t.requiresApproval} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, requiresApproval: e.target.checked } : x)))} />
                    نیازمند تایید
                  </label>
                  <Button variant="danger" onClick={() => setTransitions((arr) => arr.filter((_, j) => j !== i))}>
                    ×
                  </Button>
                </div>
                <div className="grid grid-cols-4 gap-2">
                  <Input placeholder="نوع تایید" value={t.approvalType} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, approvalType: e.target.value } : x)))} disabled={!t.requiresApproval} />
                  <Input placeholder="SLA تایید (ساعت)" value={t.slaHours} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, slaHours: e.target.value } : x)))} disabled={!t.requiresApproval} />
                  <Input placeholder="مجوز لازم" value={t.requiredPermission} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, requiredPermission: e.target.value } : x)))} />
                  <Input placeholder='شرط: {"field":"total","op":"gte","value":100}' value={t.conditionJson} onChange={(e) => setTransitions((arr) => arr.map((x, j) => (j === i ? { ...x, conditionJson: e.target.value } : x)))} className="font-mono text-[11px]" dir="ltr" />
                </div>
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              انصراف
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void createDefinition()}>
              {busy ? "در حال ثبت…" : "ثبت تعریف"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── start instance modal ── */}
      <Modal open={startOpen} title="شروع نمونه گردش کار" onClose={() => setStartOpen(false)}>
        <div className="space-y-3">
          <label className="block text-xs text-slate-600">
            تعریف
            <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={startCode} onChange={(e) => setStartCode(e.target.value)}>
              <option value="">انتخاب…</option>
              {definitions.filter((d) => d.isActive).map((d) => (
                <option key={d.id} value={d.code}>
                  {d.name} ({d.code})
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              نوع موجودیت
              <select className="mt-1 w-full rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm" value={startEntity} onChange={(e) => setStartEntity(e.target.value)}>
                {Object.entries(ENTITY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-600">
              شناسه موجودیت (UUID)
              <Input value={startEntityId} onChange={(e) => setStartEntityId(e.target.value)} dir="ltr" />
            </label>
          </div>
          <label className="block text-xs text-slate-600">
            زمینه (JSON — برای شرط‌های انتقال)
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
              dir="ltr"
              rows={3}
              value={startContext}
              onChange={(e) => setStartContext(e.target.value)}
              placeholder='{"order": {"total": 250}}'
            />
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="ghost" onClick={() => setStartOpen(false)}>
              انصراف
            </Button>
            <Button variant="primary" disabled={busy || !startCode || !startEntityId.trim()} onClick={() => void startInstance()}>
              {busy ? "…" : "شروع"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── instance detail modal ── */}
      <Modal open={detail !== null} title={detail ? `نمونه ${detail.definition.name}` : ""} onClose={() => setDetail(null)}>
        {detail && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 text-xs text-slate-600">
              <span className={`rounded px-2 py-0.5 font-medium ${STATUS_BADGES[detail.status]}`}>{STATUS_LABELS[detail.status]}</span>
              <span>مرحله: {detail.currentState?.name ?? "—"}</span>
              <span>نسخه: {faDigits(detail.version)}</span>
              <span>
                مرجع:{" "}
                {detail.entityType === "loading" ? (
                  <Link href={`/loadings/${detail.entityId}`} className="text-sky-700 hover:underline">
                    بارگیری
                  </Link>
                ) : (
                  (ENTITY_LABELS[detail.entityType] ?? detail.entityType)
                )}
              </span>
            </div>

            {detail.status === "ACTIVE" && (
              <div className="space-y-1">
                <h3 className="text-xs font-bold text-slate-700">انتقال‌های مجاز</h3>
                {availableTransitions.length === 0 && <p className="text-xs text-slate-500">انتقالی از این مرحله تعریف نشده است.</p>}
                {availableTransitions.map((t) => (
                  <div key={t.id} className="flex items-center justify-between rounded border border-slate-200 px-2 py-1.5">
                    <span className="text-xs">
                      {t.name} {t.requiredPermission && <span className="text-slate-400">({t.requiredPermission})</span>}
                      {t.requiresApproval && <span className="text-amber-700"> — نیازمند تایید</span>}
                    </span>
                    <Button variant="primary" disabled={busy} onClick={() => void executeTransition(t.code)}>
                      اجرا
                    </Button>
                  </div>
                ))}
                <div className="pt-2">
                  <Button variant="danger" disabled={busy} onClick={() => void cancelInstance()}>
                    لغو نمونه
                  </Button>
                </div>
              </div>
            )}

            {detail.approvals.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs font-bold text-slate-700">تأییدهای مرتبط</h3>
                {detail.approvals.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-xs text-slate-600">
                    <span>{a.approvalType}</span>
                    <span>
                      {a.status}
                      {a.escalationLevel > 0 && ` — escalation ${faDigits(a.escalationLevel)}`}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-1">
              <h3 className="text-xs font-bold text-slate-700">تاریخچه اجرا</h3>
              <ol className="space-y-1">
                {detail.logs.map((l) => (
                  <li key={l.id} className="flex items-baseline gap-2 text-xs">
                    <span className="tabular-nums text-slate-400">{jalaliDateTime(l.createdAt)}</span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-700">{LOG_KIND_LABELS[l.kind] ?? l.kind}</span>
                    <span className="text-slate-600">{l.transition?.name ?? l.note ?? ""}</span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
