"use client";

/**
 * CR-001 §5 — THE shared CRM chatter/timeline (Lead + Opportunity detail).
 * Same TimelineEvent machinery as the party sidebar — NO parallel history.
 */

import { useCallback, useEffect, useState } from "react";
import { jalaliDateTime } from "@/lib/format";
import type { TimelineItemDto } from "@/lib/party";

export interface CrmTimelinePanelProps {
  fetcher: () => Promise<{ items: TimelineItemDto[] }>;
  /** Bump to force a reload after sibling mutations. */
  refreshToken?: number;
  title?: string;
}

const EVENT_ICON: Record<string, string> = {
  LEAD_CREATED: "✨",
  LEAD_CONVERTED: "🔄",
  OPPORTUNITY_CREATED: "✨",
  OPPORTUNITY_STAGE_CHANGED: "➡️",
  ACTIVITY_CREATED: "📌",
  ACTIVITY_COMPLETED: "✅",
  ACTIVITY_CANCELLED: "🚫",
};

export function CrmTimelinePanel({ fetcher, refreshToken = 0, title = "تاریخچه (چرتر)" }: CrmTimelinePanelProps) {
  const [items, setItems] = useState<TimelineItemDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    fetcher()
      .then((res) => {
        if (!cancelled) {
          // Tolerate BOTH shapes: {items:[...]} (party-timeline contract) and a
          // bare array — a shape mismatch must never crash the page.
          const list = Array.isArray(res) ? res : Array.isArray(res?.items) ? res.items : [];
          setItems(list);
        }
      })
      .catch(() => {
        if (!cancelled) setError("بارگذاری تاریخچه ناموفق بود.");
      });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  useEffect(() => load(), [load, refreshToken]);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" aria-label={title}>
      <h3 className="mb-3 text-sm font-bold text-slate-800">{title}</h3>
      {error && <p className="text-xs text-red-600">{error}</p>}
      {items === null ? (
        <p className="text-xs text-slate-400">در حال بارگذاری…</p>
      ) : items.length === 0 ? (
        <p className="rounded-md border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-400">
          رویدادی ثبت نشده است.
        </p>
      ) : (
        <ol className="relative space-y-3 border-r border-slate-200 pr-3">
          {items.map((e) => (
            <li key={e.id} className="relative">
              <span className="absolute -right-[22px] top-1 text-[11px]" aria-hidden="true">
                {EVENT_ICON[e.type] ?? "•"}
              </span>
              <p className="text-xs font-medium text-slate-700">{e.title}</p>
              {e.description && <p className="text-[11px] text-slate-500">{e.description}</p>}
              <p className="text-[10px] text-slate-400">{jalaliDateTime(e.createdAt)}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default CrmTimelinePanel;
