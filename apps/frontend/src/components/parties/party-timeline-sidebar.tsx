"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { jalaliDateTime } from "@/lib/format";
import {
  fetchTimeline,
  partyErrorMessage,
  type TimelineItemDto,
} from "@/lib/party";

interface PartyTimelineSidebarProps {
  partyId: string;
  /** bumped by sibling tabs to force a refresh after they change data */
  refreshToken?: number;
}

/** Event type → navigation resolver. Returns the app route for events that
 *  reference another entity, or null for party-self events (not clickable). */
function resolveLink(type: string, data: Record<string, unknown> | null): string | null {
  const d = data ?? {};
  const doc = (k: string): string | null =>
    typeof d[k] === "string" && d[k] ? String(d[k]) : null;

  switch (type) {
    case "QUOTATION_CREATED":
    case "QUOTATION_SENT":
    case "SALE_CONFIRMED":
    case "SALE_LOST":
    case "ORDER_OVERRIDDEN": {
      const id = doc("salesDocumentId");
      return id ? `/sales/${id}` : null;
    }
    case "PURCHASE_CREATED": {
      const id = doc("purchaseDocumentId");
      return id ? `/purchases/${id}` : null;
    }
    case "PRICE_REQUEST_CREATED": {
      // No per-request detail page exists — the worklist is the surface.
      return "/price-requests";
    }
    case "LOADING_REGISTERED":
    case "LOADING_CONFIRMED":
    case "LOADING_REVERSED":
    case "LOADING_CANCELLED":
    case "LOADING_UPDATED": {
      const id = doc("loadingId");
      return id ? `/loadings/${id}` : null;
    }
    default:
      // GOODS_RECEIPT and treasury events have no dedicated page yet — not clickable.
      return null;
  }
}

/** Human label per event type (fallback: the raw type). */
const TYPE_LABELS: Record<string, string> = {
  PARTY_CREATED: "ایجاد طرف‌حساب",
  PARTY_UPDATED: "ویرایش پرونده",
  ROLE_ADDED: "افزودن نقش",
  ROLE_REMOVED: "حذف نقش",
  PHONE_ADDED: "افزودن تلفن",
  PHONE_REMOVED: "حذف تلفن",
  PHONE_PRIMARY_CHANGED: "تغییر تلفن اصلی",
  CONTACT_ADDED: "افزودن آشنا",
  CONTACT_UPDATED: "ویرایش آشنا",
  CONTACT_REMOVED: "حذف آشنا",
  ADDRESS_ADDED: "افزودن آدرس",
  ADDRESS_UPDATED: "ویرایش آدرس",
  ADDRESS_REMOVED: "حذف آدرس",
  OWNER_CHANGED: "تغییر کارشناس",
  ARCHIVED: "بایگانی",
  RESTORED: "بازگردانی",
  SCORE_RECOMPUTED: "محاسبه امتیاز",
  FINANCIAL_RESPONSIBILITY_ADDED: "افزودن گروه مسئولیت مالی",
  FINANCIAL_RESPONSIBILITY_MEMBER_ADDED: "افزودن عضو گروه مسئولیت",
  FINANCIAL_RESPONSIBILITY_REMOVED: "حذف گروه مسئولیت مالی",
  QUOTATION_CREATED: "صدور پیش‌فاکتور",
  QUOTATION_SENT: "ارسال پیش‌فاکتور",
  SALE_CONFIRMED: "تأیید سفارش فروش",
  SALE_LOST: "از دست رفتن فروش",
  ORDER_OVERRIDDEN: "بازکردن قفل سفارش",
  PURCHASE_CREATED: "ثبت خرید",
  PRICE_REQUEST_CREATED: "ثبت استعلام قیمت",
  LOADING_REGISTERED: "ثبت بارگیری",
  LOADING_CONFIRMED: "تأیید بارگیری",
  LOADING_REVERSED: "برگشت بارگیری",
  LOADING_CANCELLED: "لغو بارگیری",
  LOADING_UPDATED: "ویرایش بارگیری",
  GOODS_RECEIPT: "رسید انبار",
  DRIVER_INFO_RELEASED: "انتشار اطلاعات راننده",
  RECEIPT_CREATED: "ثبت دریافت",
  PAYMENT_CREATED: "ثبت پرداخت",
  CHECK_REGISTERED: "ثبت چک",
  CHECK_STATUS_CHANGED: "تغییر وضعیت چک",
  ACTIVITY_CREATED: "ثبت فعالیت",
  ACTIVITY_COMPLETED: "انجام فعالیت",
  ACTIVITY_OVERRIDDEN: "override فعالیت",
  RECEIPT_CONFIRMED: "تأیید رسید",
  RECEIPT_REVERSED: "برگشت رسید",
  QUOTATION_FOLLOWUP: "پیگیری پیش‌فاکتور",
};

export function PartyTimelineSidebar({ partyId, refreshToken = 0 }: PartyTimelineSidebarProps) {
  const [items, setItems] = useState<TimelineItemDto[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchTimeline(partyId, 100)
      .then((result) => {
        setItems(result.items ?? []);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(partyErrorMessage(err));
        setLoading(false);
      });
  }, [partyId]);

  useEffect(() => {
    load();
  }, [load, refreshToken]);

  return (
    <aside
      aria-label="تایم‌لاین طرف‌حساب"
      className="flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)]"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-bold text-slate-800">تاریخچه</h2>
        <Button
          size="sm"
          variant="ghost"
          onClick={load}
          aria-label="بازخوانی تایم‌لاین"
        >
          ↻
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-3">
        {loading && (
          <div className="space-y-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-10 animate-pulse rounded bg-slate-100" />
            ))}
          </div>
        )}

        {!loading && error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700">
            {error}
          </div>
        )}

        {!loading && !error && items && items.length === 0 && (
          <p className="py-4 text-center text-xs text-slate-400">رویدادی ثبت نشده است.</p>
        )}

        {!loading && !error && items && items.length > 0 && (
          <ol className="relative space-y-4 border-s-2 border-slate-100 ps-4">
            {items.map((item) => {
              const href = resolveLink(item.type, item.data as Record<string, unknown> | null);
              const inner = (
                <>
                  <span
                    className={`absolute -start-[23px] top-1 flex h-3 w-3 items-center justify-center rounded-full border-2 ${
                      href ? "border-primary-500 bg-primary-50" : "border-slate-300 bg-white"
                    }`}
                    aria-hidden="true"
                  />
                  <div className="flex flex-wrap items-baseline gap-1.5">
                    <span
                      className={`text-xs font-bold ${href ? "text-primary-700" : "text-slate-800"}`}
                    >
                      {item.title}
                    </span>
                    <span className="rounded border border-slate-200 bg-slate-50 px-1 py-px text-[9px] text-slate-500">
                      {TYPE_LABELS[item.type] ?? item.type}
                    </span>
                  </div>
                  {item.description && (
                    <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[11px] leading-4 text-slate-500">
                      {item.description}
                    </p>
                  )}
                  <p className="mt-0.5 text-[10px] tabular-nums text-slate-400">
                    {jalaliDateTime(item.createdAt)}
                  </p>
                </>
              );
              return (
                <li key={item.id} className="relative">
                  {href ? (
                    <Link
                      href={href}
                      title="رفتن به سند مرتبط"
                      className="relative -ms-1 block rounded-md px-1 py-0.5 transition-colors hover:bg-primary-50/60"
                    >
                      {inner}
                    </Link>
                  ) : (
                    <div className="relative -ms-1 px-1 py-0.5">{inner}</div>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
