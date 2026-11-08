"use client";

/**
 * CR-001 — Odoo-style Opportunity Pipeline (Kanban).
 *
 * Columns = the backend-enforced stage chain (OPEN → QUALIFIED → QUOTED →
 * WON/LOST). Cards drag between ALLOWED transitions only (the lib's
 * OPPORTUNITY_TRANSITIONS mirrors the server); a drag to «باخته» asks for
 * the mandatory lost reason. Dependency-free HTML5 drag & drop (repo
 * convention: no external UI/DnD libraries).
 *
 * Backend remains the enforcement point — an illegal drop simply fails the
 * PATCH with INVALID_OPPORTUNITY_STATUS_TRANSITION and the card snaps back.
 */

import Link from "next/link";
import { useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { OpportunityStatusBadge } from "@/components/documents/status-badges";
import { faDigits, faMoneyExact, jalali } from "@/lib/format";
import {
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS_LABELS,
  OPPORTUNITY_TRANSITIONS,
  updateOpportunity,
  type OpportunityDto,
  type OpportunityStatus,
} from "@/lib/crm";

const STAGE_TONE: Record<OpportunityStatus, string> = {
  OPEN: "border-amber-300 bg-amber-50",
  QUALIFIED: "border-sky-300 bg-sky-50",
  QUOTED: "border-indigo-300 bg-indigo-50",
  WON: "border-emerald-300 bg-emerald-50",
  LOST: "border-rose-300 bg-rose-50",
};

export interface OpportunityKanbanProps {
  items: OpportunityDto[];
  canManage: boolean;
  onChanged: () => void;
}

export function OpportunityKanban({ items, canManage, onChanged }: OpportunityKanbanProps) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<OpportunityStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Drop to LOST needs the mandatory reason → staged in this modal.
  const [lostDrop, setLostDrop] = useState<{ opportunity: OpportunityDto } | null>(null);
  const [lostReasonId, setLostReasonId] = useState("");
  const [lostReasons, setLostReasons] = useState<Awaited<ReturnType<typeof import("@/lib/crm").fetchLostReasons>>>([]);

  function beginDrag(opp: OpportunityDto) {
    if (!canManage || opp.status === "WON" || opp.status === "LOST") return;
    setDragId(opp.id);
  }

  function finishDrag(target: OpportunityStatus, reasonId?: string) {
    const opp = items.find((o) => o.id === dragId);
    setDragId(null);
    setDragOver(null);
    if (!opp || !canManage || busy) return;
    if (target === opp.status) return;
    if (!OPPORTUNITY_TRANSITIONS[opp.status].includes(target)) {
      setError(`عبور از مرحلهٔ «${OPPORTUNITY_STATUS_LABELS[target]}» برای این کارت مجاز نیست.`);
      return;
    }
    setBusy(true);
    updateOpportunity(opp.id, {
      status: target,
      ...(target === "LOST" && reasonId ? { lostReasonId: reasonId } : {}),
      version: opp.version,
    })
      .then(() => onChanged())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "جابه‌جایی کارت ناموفق بود.");
      })
      .finally(() => setBusy(false));
  }

  function onDrop(target: OpportunityStatus) {
    if (target === "LOST") {
      const opp = items.find((o) => o.id === dragId);
      if (!opp) return;
      setLostDrop({ opportunity: opp });
      if (lostReasons.length === 0) {
        void import("@/lib/crm").then(({ fetchLostReasons }) =>
          fetchLostReasons().then(setLostReasons).catch(() => undefined),
        );
      }
      setDragId(null);
      setDragOver(null);
      return;
    }
    finishDrag(target);
  }

  return (
    <div className="space-y-2">
      {error && (
        <div role="alert" className="flex items-center justify-between rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          <button type="button" className="font-bold underline" onClick={() => setError(null)}>
            بستن
          </button>
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 overflow-x-auto pb-2 sm:grid-cols-2 xl:grid-cols-5">
        {OPPORTUNITY_STATUSES.map((stage) => {
          const stageItems = items.filter((o) => o.status === stage);
          const droppable =
            canManage && dragId !== null && dragOver === stage;
          return (
            <div
              key={stage}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(stage);
              }}
              onDragLeave={() => setDragOver((cur) => (cur === stage ? null : cur))}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(stage);
              }}
              className={`flex min-h-32 flex-col rounded-xl border p-2 ${STAGE_TONE[stage]} ${
                droppable ? "ring-2 ring-primary-400" : ""
              }`}
              aria-label={`ستون ${OPPORTUNITY_STATUS_LABELS[stage]}`}
            >
              <div className="mb-1.5 flex items-center justify-between px-1">
                <span className="text-xs font-bold text-slate-700">{OPPORTUNITY_STATUS_LABELS[stage]}</span>
                <span className="rounded-full bg-white/70 px-2 text-[11px] text-slate-500">
                  {faDigits(stageItems.length)}
                </span>
              </div>
              <div className="flex flex-1 flex-col gap-1.5">
                {stageItems.map((opp) => {
                  const overdue = (opp.activity?.overdueCount ?? 0) > 0;
                  return (
                    <div
                      key={opp.id}
                      draggable={canManage && opp.status !== "WON" && opp.status !== "LOST"}
                      onDragStart={() => beginDrag(opp)}
                      className={`rounded-lg border border-slate-200 bg-white p-2 shadow-sm ${
                        canManage && opp.status !== "WON" && opp.status !== "LOST" ? "cursor-grab" : ""
                      } ${dragId === opp.id ? "opacity-50" : ""}`}
                    >
                      <Link href={`/crm/opportunities/${opp.id}`} className="block text-xs font-bold text-primary-700 hover:underline">
                        {opp.title}
                      </Link>
                      <p className="mt-0.5 truncate text-[11px] text-slate-500">{opp.customer.nameFa}</p>
                      {opp.estimatedAmount && (
                        <p className="mt-0.5 text-[11px] text-slate-700" dir="ltr">
                          {faMoneyExact(opp.estimatedAmount)}
                        </p>
                      )}
                      <div className="mt-1 flex items-center justify-between text-[10px] text-slate-400">
                        <span>
                          {opp.expectedCloseDate ? `بستن: ${jalali(opp.expectedCloseDate)}` : ""}
                        </span>
                        {overdue && <span className="rounded bg-rose-100 px-1.5 py-0.5 font-medium text-rose-600">عقب‌افتاده</span>}
                      </div>
                      {opp.activity?.nextActivityAt && (
                        <p className="mt-0.5 text-[10px] text-slate-500">
                          بعدی: {opp.activity.nextActivityTitle ?? "فعالیت"} — {jalali(opp.activity.nextActivityAt)}
                        </p>
                      )}
                    </div>
                  );
                })}
                {stageItems.length === 0 && (
                  <p className="rounded-md border border-dashed border-slate-300/70 px-2 py-3 text-center text-[10px] text-slate-400">
                    خالی
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <Modal
        open={lostDrop !== null}
        title={`دلیل از دست رفتن: ${lostDrop?.opportunity.title ?? ""}`}
        onClose={() => setLostDrop(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setLostDrop(null)}>
              انصراف (Esc)
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!lostReasonId || busy}
              onClick={() => {
                if (lostDrop) finishDrag("LOST", lostReasonId);
                setLostDrop(null);
              }}
            >
              ثبت باخت
            </Button>
          </>
        }
      >
        <label htmlFor="kanban-lost-reason" className="mb-1 block text-xs font-medium text-slate-600">
          دلیل باخت * (الزامیِ backend)
        </label>
        <select
          id="kanban-lost-reason"
          value={lostReasonId}
          onChange={(e) => setLostReasonId(e.target.value)}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="">انتخاب کنید…</option>
          {lostReasons.map((r) => (
            <option key={r.id} value={r.id}>
              {r.nameFa}
            </option>
          ))}
        </select>
      </Modal>
    </div>
  );
}

export default OpportunityKanban;
