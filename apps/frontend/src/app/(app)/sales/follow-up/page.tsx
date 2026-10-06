"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { SaleStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali } from "@/lib/format";
import {
  salesErrorMessage,
  fetchSales,
  loseSale,
  sendSale,
  type SalesDocumentListItem,
  type SalesDocumentStatus,
} from "@/lib/sales";
import { fetchLostReasons, type LostReasonDto } from "@/lib/crm";

const PAGE_SIZE = 20;

type FollowUpTab = "QUOTATION" | "SENT" | "EXPIRED";

const TABS: { key: FollowUpTab; label: string }[] = [
  { key: "QUOTATION", label: "پیش‌فاکتورهای در انتظار پاسخ" },
  { key: "SENT", label: "ارسال‌شده" },
  { key: "EXPIRED", label: "منقضی‌شده" },
];

/** Days elapsed since the document date. */
function ageDays(documentDate: string): number {
  const then = new Date(documentDate).getTime();
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.floor((Date.now() - then) / (24 * 60 * 60 * 1000)));
}

export default function FollowUpPage() {
  const [tab, setTab] = useState<FollowUpTab>("QUOTATION");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    items: SalesDocumentListItem[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Lost modal
  const [lostTarget, setLostTarget] = useState<SalesDocumentListItem | null>(null);
  const [lostReasons, setLostReasons] = useState<LostReasonDto[]>([]);
  const [lostReasonId, setLostReasonId] = useState("");
  const [lostNotes, setLostNotes] = useState("");
  const [losing, setLosing] = useState(false);
  const [lostError, setLostError] = useState<string | null>(null);

  const [sendingId, setSendingId] = useState<string | null>(null);

  const query = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      sortDir: "asc" as const,
      ...(tab === "EXPIRED" ? { expired: true } : { status: tab as SalesDocumentStatus }),
    }),
    [page, tab],
  );

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSales(query)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(salesErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => load(), [load, reloadToken]);

  const openLostModal = useCallback(async (sale: SalesDocumentListItem) => {
    setLostTarget(sale);
    setLostReasonId("");
    setLostNotes("");
    setLostError(null);
    if (lostReasons.length === 0) {
      try {
        setLostReasons(await fetchLostReasons(true));
      } catch {
        /* backend enforces the requirement anyway */
      }
    }
  }, [lostReasons.length]);

  async function handleLost() {
    if (!lostTarget) return;
    if (!lostReasonId) {
      setLostError("انتخاب دلیل باخت الزامی است.");
      return;
    }
    setLosing(true);
    setLostError(null);
    try {
      await loseSale(lostTarget.id, {
        lostReasonId,
        ...(lostNotes.trim() ? { notes: lostNotes.trim() } : {}),
      });
      setLostTarget(null);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setLostError(salesErrorMessage(err));
    } finally {
      setLosing(false);
    }
  }

  async function handleSend(sale: SalesDocumentListItem) {
    setSendingId(sale.id);
    setError(null);
    try {
      await sendSale(sale.id);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setError(salesErrorMessage(err));
    } finally {
      setSendingId(null);
    }
  }

  const columns = useMemo<DataTableColumn<SalesDocumentListItem>[]>(
    () => [
      {
        key: "documentNumber",
        header: "شماره",
        render: (row) => (
          <span dir="ltr" className="block text-start font-medium text-primary-700">
            {row.documentNumber}
          </span>
        ),
      },
      { key: "customer", header: "مشتری", render: (row) => row.customer?.nameFa ?? "—" },
      { key: "salesperson", header: "فروشنده", render: (row) => row.salesperson?.name ?? "—" },
      {
        key: "age",
        header: "سن (روز از تاریخ)",
        align: "center",
        render: (row) => {
          const days = ageDays(row.documentDate);
          return (
            <span
              className={`tabular-nums ${
                days >= 14 ? "font-bold text-red-600" : days >= 7 ? "text-amber-600" : "text-slate-600"
              }`}
            >
              {faDigits(days)}
            </span>
          );
        },
      },
      {
        key: "expirationDate",
        header: "انقضا",
        render: (row) => (
          <span className="tabular-nums text-slate-500">{jalali(row.expirationDate)}</span>
        ),
      },
      {
        key: "status",
        header: "وضعیت",
        align: "center",
        render: (row) => <SaleStatusBadge status={row.status} />,
      },
      {
        key: "actions",
        header: "",
        align: "end",
        render: (row) => (
          <div className="flex items-center justify-end gap-1">
            {row.status === "QUOTATION" && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void handleSend(row)}
                disabled={sendingId === row.id}
              >
                ارسال
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => void openLostModal(row)}>
              ثبت باخت
            </Button>
          </div>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sendingId, openLostModal],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-800">پیگیری پیش‌فاکتورها</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          پیش‌فاکتورهایی که هنوز سفارش فروش نشده‌اند — قدیمی‌ترین‌ها اول
        </p>
      </div>

      <div className="flex overflow-hidden rounded-md border border-slate-300 bg-white" role="tablist" aria-label="بازه پیگیری">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => {
              setTab(item.key);
              setPage(1);
            }}
            className={`px-4 py-2 text-xs font-medium transition-colors ${
              tab === item.key
                ? "bg-primary-600 text-white"
                : "bg-white text-slate-600 hover:bg-slate-50"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}{" "}
          <button type="button" className="font-bold underline" onClick={() => setReloadToken((t) => t + 1)}>
            تلاش مجدد
          </button>
        </div>
      )}

      <DataTable<SalesDocumentListItem>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/sales/${row.id}`}
        getRowAriaLabel={(row) => `مشاهده سند ${row.documentNumber}`}
        loading={loading}
        dense
        ariaLabel="فهرست پیگیری پیش‌فاکتورها"
        emptyMessage="موردی برای پیگیری نیست."
        pagination={
          data
            ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }
            : null
        }
      />

      <Modal
        open={lostTarget !== null}
        title={`ثبت باخت ${lostTarget?.documentNumber ?? ""}`}
        onClose={() => setLostTarget(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setLostTarget(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" variant="danger" onClick={() => void handleLost()} disabled={losing}>
              {losing ? "در حال ثبت…" : "ثبت باخت"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {lostError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {lostError}
            </div>
          )}
          <div>
            <label htmlFor="fu-lost-reason" className="mb-1 block text-xs font-medium text-slate-600">
              دلیل باخت *
            </label>
            <select
              id="fu-lost-reason"
              value={lostReasonId}
              onChange={(event) => setLostReasonId(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">انتخاب کنید…</option>
              {lostReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.nameFa}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="fu-lost-notes" className="mb-1 block text-xs font-medium text-slate-600">
              توضیحات
            </label>
            <textarea
              id="fu-lost-notes"
              rows={2}
              value={lostNotes}
              onChange={(event) => setLostNotes(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              aria-label="توضیحات باخت"
            />
          </div>
          <p className="text-xs text-slate-400">
            پس از ثبت باخت، سند در وضعیت «از دست رفته» قرار می‌گیرد.{" "}
            {lostTarget && (
              <Link href={`/sales/${lostTarget.id}`} className="text-primary-600 underline">
                مشاهده سند
              </Link>
            )}
          </p>
        </div>
      </Modal>
    </div>
  );
}
