"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  LOADING_STATUS_BADGE_CLASSES,
  LOADING_STATUS_LABELS,
  LOADING_STATUSES,
  fetchLoadings,
  loadingErrorMessage,
  type LoadingListItem,
  type LoadingStatus,
} from "@/lib/loading";

type ListRow = LoadingListItem;

export default function LoadingsListPage() {
  const [rows, setRows] = useState<ListRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<LoadingStatus | "">("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchLoadings({ page, pageSize, status: status || undefined });
      setRows(res.items as ListRow[]);
      setTotal(res.total);
    } catch (e) {
      setError(loadingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<ListRow>[] = [
    {
      key: "date",
      header: "تاریخ",
      render: (r) => <span className="text-xs tabular-nums text-slate-700">{jalaliDateTime(r.loadingDate)}</span>,
    },
    {
      key: "customer",
      header: "مشتری",
      render: (r) =>
        r.customer ? (
          <Link href={`/parties/${r.customer.id}`} className="text-sm text-sky-700 hover:underline">
            {r.customer.nameFa}
          </Link>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: "driver",
      header: "راننده / ناقل",
      render: (r) =>
        r.driverInfoRestricted ? (
          <span className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs text-amber-700">
            مخفی تا تأیید مدیر
          </span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: "warehouse",
      header: "انبار",
      render: (r) => <span className="text-xs text-slate-600">{r.warehouse?.nameFa ?? "—"}</span>,
    },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${LOADING_STATUS_BADGE_CLASSES[r.status]}`}>
          {LOADING_STATUS_LABELS[r.status]}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "ایجاد",
      render: (r) => <span className="text-xs tabular-nums text-slate-500">{jalaliDateTime(r.createdAt)}</span>,
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-bold text-slate-800">بارگیری‌ها</h1>
        <Link href="/loadings/new">
          <Button variant="primary">بارگیری جدید</Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="w-64">
          <Input
            aria-label="جستجو"
            placeholder="جستجو (Enter برای اعمال)"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setPage(1);
                void load();
              }
            }}
          />
        </div>
        <div>
          <select
            aria-label="وضعیت"
            className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as LoadingStatus | "");
              setPage(1);
            }}
          >
            <option value="">همه وضعیت‌ها</option>
            {LOADING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LOADING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" onClick={() => void load()}>
          بروزرسانی
        </Button>
      </div>

      {error && (
        <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        rowHref={(r) => `/loadings/${r.id}`}
        loading={loading}
        emptyMessage="بارگیری‌ای یافت نشد"
      />

      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>
          مجموع {faDigits(total)} رکورد — صفحه {faDigits(page)} از {faDigits(totalPages)}
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
    </div>
  );
}
