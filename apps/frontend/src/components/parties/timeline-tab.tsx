"use client";

import { useEffect, useState } from "react";
import { jalaliDateTime } from "@/lib/format";
import {
  fetchTimeline,
  partyErrorMessage,
  type PartyDetail,
  type TimelineItemDto,
} from "@/lib/party";

interface TimelineTabProps {
  party: PartyDetail;
}

const TYPE_LABELS: Record<string, string> = {
  CREATED: "ایجاد",
  UPDATED: "ویرایش",
  ROLE_ADDED: "افزودن نقش",
  ROLE_REMOVED: "حذف نقش",
  PHONE_ADDED: "افزودن تلفن",
  PHONE_REMOVED: "حذف تلفن",
  CONTACT_ADDED: "افزودن آشنا",
  CONTACT_REMOVED: "حذف آشنا",
  ADDRESS_ADDED: "افزودن آدرس",
  ADDRESS_REMOVED: "حذف آدرس",
  OWNER_CHANGED: "تغییر مالک",
  ARCHIVED: "بایگانی",
  RESTORED: "بازگردانی",
  SCORE_RECOMPUTED: "محاسبه امتیاز",
};

export function TimelineTab({ party }: TimelineTabProps) {
  const [items, setItems] = useState<TimelineItemDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTimeline(party.id, 50)
      .then((result) => {
        if (!cancelled) {
          setItems(result.items ?? []);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(partyErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [party.id, party.version]);

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-400 shadow-sm">
        در حال بارگذاری تایم‌لاین…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 shadow-sm">
        {error}
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-400 shadow-sm">
        رویدادی ثبت نشده است.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-bold text-slate-800">تایم‌لاین</h3>
      <ol className="relative space-y-6 border-s-2 border-slate-200 ps-6">
        {items.map((item) => (
          <li key={item.id} className="relative">
            <span
              className="absolute -start-[31px] top-1 flex h-3 w-3 items-center justify-center rounded-full border-2 border-primary-500 bg-white"
              aria-hidden="true"
            />
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-bold text-slate-800">{item.title}</span>
              {(item.type || item.actorType) && (
                <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                  {TYPE_LABELS[item.type] ?? item.actorType ?? item.type}
                </span>
              )}
            </div>
            {item.description && (
              <p className="mt-1 whitespace-pre-wrap text-xs text-slate-600">
                {item.description}
              </p>
            )}
            <p className="mt-1 text-[11px] tabular-nums text-slate-400">
              {jalaliDateTime(item.createdAt)}
            </p>
          </li>
        ))}
      </ol>
    </div>
  );
}
