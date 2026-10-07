"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalali, jalaliDateTime } from "@/lib/format";
import {
  PUBLISH_BATCH_STATUS_BADGE_CLASSES,
  PUBLISH_BATCH_STATUS_LABELS,
  PUBLISH_CHANNEL_LABELS,
  PUBLISH_ITEM_STATUS_BADGE_CLASSES,
  PUBLISH_ITEM_STATUS_LABELS,
  cancelPublishItem,
  fetchPublishBatch,
  publishingErrorMessage,
  retryPublishItem,
  type PublishBatchDetail,
  type PublishBatchItemDto,
  type PublishBatchStatus,
  type PublishItemStatus,
} from "@/lib/publishing";

const RETRYABLE: PublishItemStatus[] = ["FAILED", "CANCELLED"];
const CANCELLABLE: PublishItemStatus[] = ["PENDING", "FAILED"];
const POLL_MS = 5000;

function ItemStatusBadge({ status }: { status: PublishItemStatus }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${PUBLISH_ITEM_STATUS_BADGE_CLASSES[status]}`}
    >
      {PUBLISH_ITEM_STATUS_LABELS[status]}
    </span>
  );
}

function prettyJson(value: unknown): string {
  if (value === null || value === undefined) return "—";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export default function PublishBatchDetailPage() {
  const params = useParams<{ id: string }>();
  const batchId = typeof params?.id === "string" ? params.id : "";

  const [batch, setBatch] = useState<PublishBatchDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [cancelTarget, setCancelTarget] = useState<PublishBatchItemDto | null>(null);
  const [acting, setActing] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!batchId) return;
      if (!silent) setLoading(true);
      try {
        const detail = await fetchPublishBatch(batchId);
        setBatch(detail);
        setError(null);
      } catch (err) {
        setError(publishingErrorMessage(err));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [batchId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const inFlight = useMemo(
    () => batch?.status === "PENDING" || batch?.status === "PROCESSING",
    [batch?.status],
  );

  // Poll every 5s while the batch is queued/processing; stop when settled.
  useEffect(() => {
    if (!batchId || !inFlight) return;
    const timer = setInterval(() => {
      void load(true);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [batchId, inFlight, load]);

  const counts = useMemo(() => {
    const items = batch?.items ?? [];
    return {
      success: items.filter((item) => item.status === "SUCCESS").length,
      failed: items.filter((item) => item.status === "FAILED").length,
      pending: items.filter((item) => item.status === "PENDING" || item.status === "PROCESSING")
        .length,
      cancelled: items.filter((item) => item.status === "CANCELLED").length,
    };
  }, [batch]);

  function toggleExpanded(itemId: string) {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  async function handleRetry(itemId: string) {
    setActionError(null);
    setActing(true);
    try {
      await retryPublishItem(itemId);
      await load(true);
    } catch (err) {
      setActionError(publishingErrorMessage(err));
    } finally {
      setActing(false);
    }
  }

  async function handleCancel() {
    if (!cancelTarget) return;
    setActionError(null);
    setActing(true);
    try {
      await cancelPublishItem(cancelTarget.id);
      setCancelTarget(null);
      await load(true);
    } catch (err) {
      setActionError(publishingErrorMessage(err));
    } finally {
      setActing(false);
    }
  }

  const statusBadgeClass = batch
    ? PUBLISH_BATCH_STATUS_BADGE_CLASSES[batch.status as PublishBatchStatus] ??
      "border-slate-300 bg-slate-100 text-slate-600"
    : "";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-slate-800">
              بچ انتشار <span dir="ltr">{batch?.batchNumber ?? ""}</span>
            </h2>
            {batch && (
              <span
                className={`rounded border px-2 py-0.5 text-[11px] font-bold ${statusBadgeClass}`}
              >
                {PUBLISH_BATCH_STATUS_LABELS[batch.status as PublishBatchStatus] ?? batch.status}
              </span>
            )}
            {inFlight && (
              <span className="flex items-center gap-1 text-[11px] text-sky-600">
                <svg
                  className="h-3.5 w-3.5 animate-spin"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
                </svg>
                به‌روزرسانی خودکار هر ۵ ثانیه
              </span>
            )}
          </div>
          {batch && (
            <p className="mt-0.5 text-xs text-slate-500">
              تاریخ قیمت: <span className="tabular-nums">{jalali(batch.priceDate)}</span>
              <span className="mx-2 text-slate-300">|</span>
              ایجاد: <span className="tabular-nums">{jalaliDateTime(batch.createdAt)}</span>
              {batch.finishedAt && (
                <>
                  <span className="mx-2 text-slate-300">|</span>
                  پایان: <span className="tabular-nums">{jalaliDateTime(batch.finishedAt)}</span>
                </>
              )}
              {batch.notes && (
                <>
                  <span className="mx-2 text-slate-300">|</span>
                  یادداشت: {batch.notes}
                </>
              )}
            </p>
          )}
        </div>
        <Link href="/publishing">
          <Button variant="secondary" size="sm">
            بازگشت به صف انتشار
          </Button>
        </Link>
      </div>

      {/* Summary counts */}
      {batch && (
        <div className="flex flex-wrap gap-2">
          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">
            موفق: {faDigits(counts.success)}
          </span>
          <span className="rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-bold text-red-700">
            ناموفق: {faDigits(counts.failed)}
          </span>
          <span className="rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-bold text-slate-600">
            در انتظار: {faDigits(counts.pending)}
          </span>
          <span className="rounded-md border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-bold text-rose-700">
            لغو: {faDigits(counts.cancelled)}
          </span>
        </div>
      )}

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {actionError && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {actionError}
        </div>
      )}
      {loading && !batch && <p className="text-sm text-slate-400">در حال بارگذاری بچ…</p>}

      {batch && (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm" aria-label="آیتم‌های بچ انتشار">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-500">
                  <th scope="col" className="px-3 py-2 text-start">کانال</th>
                  <th scope="col" className="px-3 py-2 text-start">مقصد</th>
                  <th scope="col" className="px-3 py-2 text-start">سند</th>
                  <th scope="col" className="px-3 py-2 text-center">وضعیت</th>
                  <th scope="col" className="px-3 py-2 text-start">ایجاد</th>
                  <th scope="col" className="px-3 py-2 text-center">تلاش‌ها</th>
                  <th scope="col" className="px-3 py-2 text-start">خطا</th>
                  <th scope="col" className="px-3 py-2 text-center">اکشن‌ها</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {batch.items.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-8 text-center text-sm text-slate-400">
                      هیچ آیتمی برای این بچ ثبت نشده است.
                    </td>
                  </tr>
                ) : (
                  batch.items.map((item) => {
                    const canRetry = RETRYABLE.includes(item.status);
                    const canCancel = CANCELLABLE.includes(item.status);
                    const expanded = expandedIds.has(item.id);
                    return (
                      <Fragment key={item.id}>
                        <tr className="align-top">
                          <td className="px-3 py-2 text-xs font-semibold text-slate-700">
                            {PUBLISH_CHANNEL_LABELS[item.channel] ?? item.channel}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            {item.destination ? (
                              <span dir="ltr" className="font-mono text-[11px]">
                                {item.destination}
                              </span>
                            ) : (
                              <span className="text-slate-400">پیش‌فرض کانال</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-600">
                            {item.template ? (
                              <>
                                <span dir="ltr" className="font-medium text-slate-700">
                                  {item.template.code}
                                </span>
                                <span className="block text-[10px] text-slate-400">
                                  {item.template.nameFa}
                                </span>
                              </>
                            ) : (
                              "—"
                            )}
                            <span dir="ltr" className="mt-0.5 block text-[10px] text-slate-400">
                              {batch.batchNumber}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <ItemStatusBadge status={item.status} />
                          </td>
                          <td className="px-3 py-2 text-xs tabular-nums text-slate-500">
                            {jalaliDateTime(item.createdAt)}
                          </td>
                          <td className="px-3 py-2 text-center text-xs tabular-nums text-slate-600">
                            {faDigits(item.attemptCount)}/{faDigits(item.maxAttempts)}
                          </td>
                          <td className="max-w-56 px-3 py-2 text-xs text-red-600">
                            {item.lastError ? (
                              <span dir="ltr" className="line-clamp-2 block break-all text-[11px]">
                                {item.lastError}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center justify-center gap-1">
                              {canRetry && (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  disabled={acting}
                                  onClick={() => void handleRetry(item.id)}
                                  aria-label={`تلاش مجدد آیتم ${PUBLISH_CHANNEL_LABELS[item.channel]}`}
                                >
                                  تلاش مجدد
                                </Button>
                              )}
                              {canCancel && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  disabled={acting}
                                  onClick={() => setCancelTarget(item)}
                                  aria-label={`لغو آیتم ${PUBLISH_CHANNEL_LABELS[item.channel]}`}
                                >
                                  لغو
                                </Button>
                              )}
                              {Boolean(item.lastError || item.providerResponse) && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => toggleExpanded(item.id)}
                                  aria-expanded={expanded}
                                  aria-label="مشاهده خطا"
                                >
                                  {expanded ? "بستن جزئیات" : "مشاهده خطا"}
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {expanded && (
                          <tr className="bg-slate-50/60">
                            <td colSpan={8} className="px-4 py-3">
                              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                                <div>
                                  <p className="mb-1 text-[11px] font-bold text-slate-500">خطای آخر</p>
                                  <pre
                                    dir="ltr"
                                    className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-red-100 bg-red-50/60 p-2 text-[11px] text-red-700"
                                  >
                                    {item.lastError ?? "—"}
                                  </pre>
                                </div>
                                <div>
                                  <p className="mb-1 text-[11px] font-bold text-slate-500">
                                    پاسخ ارائه‌دهنده
                                  </p>
                                  <pre
                                    dir="ltr"
                                    className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-md border border-slate-200 bg-white p-2 text-[11px] text-slate-600"
                                  >
                                    {prettyJson(item.providerResponse)}
                                  </pre>
                                </div>
                              </div>
                              <div className="mt-3">
                                <p className="mb-1 text-[11px] font-bold text-slate-500">
                                  متن رندرشده
                                </p>
                                <pre
                                  dir="rtl"
                                  className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-white p-2 text-[11px] leading-6 text-slate-600"
                                >
                                  {(() => {
                                    const payload = item.renderedPayload as
                                      | { messageText?: string }
                                      | null;
                                    return payload?.messageText ?? "—";
                                  })()}
                                </pre>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <Modal
        open={cancelTarget !== null}
        title="لغو آیتم انتشار"
        onClose={() => setCancelTarget(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCancelTarget(null)}>
              انصراف (Esc)
            </Button>
            <Button variant="danger" size="sm" onClick={() => void handleCancel()} disabled={acting}>
              {acting ? "در حال لغو…" : "لغو آیتم"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          آیتم «{PUBLISH_CHANNEL_LABELS[cancelTarget?.channel ?? "WEBSITE"]}»
          {cancelTarget?.destination ? (
            <>
              {" "}
              به مقصد <span dir="ltr">{cancelTarget.destination}</span>
            </>
          ) : null}{" "}
          لغو شود؟ این عمل بازگشت‌پذیر است؛ می‌توانید بعداً «تلاش مجدد» بزنید.
        </p>
      </Modal>
    </div>
  );
}
