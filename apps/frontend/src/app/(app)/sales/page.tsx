"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/ui/data-table";
import { SaleStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali, toNum, thousandSeparate } from "@/lib/format";
import {
  SALES_STATUSES,
  SALES_STATUS_LABELS,
  fetchSales,
  salesErrorMessage,
  type SalesDocumentListItem,
  type SalesDocumentStatus,
} from "@/lib/sales";

const PAGE_SIZE = 20;

function partyMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  return { id, label: typeof item.nameFa === "string" && item.nameFa ? item.nameFa : id };
}

function userMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const name = [item.firstName, item.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();
  return { id, label: name || (typeof item.username === "string" ? item.username : id) };
}

export default function SalesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<SalesDocumentStatus | "">("");
  const [customer, setCustomer] = useState<EntityOption | null>(null);
  const [salesperson, setSalesperson] = useState<EntityOption | null>(null);
  const [expiredOnly, setExpiredOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);

  const [data, setData] = useState<{
    items: SalesDocumentListItem[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Debounced search.
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      status: status || undefined,
      customerPartyId: customer?.id,
      salespersonUserId: salesperson?.id,
      expired: expiredOnly || undefined,
      sortDir: (sort?.dir ?? "desc") as "asc" | "desc",
    }),
    [page, search, status, customer, salesperson, expiredOnly, sort],
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

  const handleSortChange = useCallback((next: DataTableSort) => {
    setSort(next);
    setPage(1);
  }, []);

  const columns = useMemo<DataTableColumn<SalesDocumentListItem>[]>(
    () => [
      {
        key: "documentNumber",
        header: "شماره SD",
        sortable: true,
        render: (row) => (
          <span dir="ltr" className="block text-start font-medium text-primary-700">
            {row.documentNumber}
          </span>
        ),
      },
      {
        key: "customer",
        header: "مشتری",
        render: (row) => row.customer?.nameFa ?? "—",
      },
      {
        key: "salesperson",
        header: "فروشنده",
        render: (row) => row.salesperson?.name ?? "—",
      },
      {
        key: "documentDate",
        header: "تاریخ",
        sortable: true,
        render: (row) => (
          <span className="tabular-nums text-slate-500">{jalali(row.documentDate)}</span>
        ),
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
        key: "total",
        header: "مبلغ کل",
        align: "end",
        render: (row) => {
          const value = toNum(row.totals?.total);
          return value !== null ? (
            <span className="tabular-nums">{faDigits(thousandSeparate(value))}</span>
          ) : (
            "—"
          );
        },
      },
      {
        key: "lineCount",
        header: "خطوط",
        align: "center",
        render: (row) => faDigits(row.lineCount),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">اسناد فروش</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            پیش‌فاکتور تا سفارش فروش — یک سند، یک شماره (SD)
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/sales/follow-up" tabIndex={-1}>
            <Button variant="secondary" size="md" aria-label="پیگیری پیش‌فاکتورها">
              پیگیری پیش‌فاکتورها
            </Button>
          </Link>
          <Link href="/allocations" tabIndex={-1}>
            <Button variant="secondary" size="md" aria-label="تخصیص بار">
              تخصیص بار
            </Button>
          </Link>
          <Link href="/sales/new" tabIndex={-1}>
            <Button variant="primary" aria-label="ایجاد پیش‌فاکتور جدید">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              پیش‌فاکتور جدید
            </Button>
          </Link>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-52">
          <label htmlFor="sale-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (شماره سند، مشتری)
          </label>
          <Input
            id="sale-search"
            inputSize="sm"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                setSearch(searchInput.trim());
                setPage(1);
              }
            }}
            placeholder="SD-1405-…"
            aria-label="جستجوی اسناد فروش"
          />
        </div>
        <div className="w-40">
          <label htmlFor="sale-status" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="sale-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as SalesDocumentStatus | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {SALES_STATUSES.map((value) => (
              <option key={value} value={value}>
                {SALES_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="w-52">
          <label className="mb-1 block text-xs font-medium text-slate-600">مشتری</label>
          <EntitySelector
            endpoint={(q) => `/parties?role=CUSTOMER&search=${encodeURIComponent(q)}&pageSize=10`}
            mapItem={partyMapItem}
            value={customer}
            onChange={(next) => {
              setCustomer(next);
              setPage(1);
            }}
            placeholder="همه مشتریان"
            ariaLabel="فیلتر مشتری"
            emptySearchLabel="برای جستجوی مشتری تایپ کنید"
          />
        </div>
        <div className="w-52">
          <label className="mb-1 block text-xs font-medium text-slate-600">فروشنده</label>
          <EntitySelector
            endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
            mapItem={userMapItem}
            value={salesperson}
            onChange={(next) => {
              setSalesperson(next);
              setPage(1);
            }}
            placeholder="همه فروشندگان"
            ariaLabel="فیلتر فروشنده"
            emptySearchLabel="برای جستجوی فروشنده تایپ کنید"
          />
        </div>
        <label className="flex h-8 cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={expiredOnly}
            onChange={(event) => {
              setExpiredOnly(event.target.checked);
              setPage(1);
            }}
            className="h-4 w-4 accent-primary-600"
          />
          فقط منقضی‌شده‌ها
        </label>
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
        sort={sort}
        onSortChange={handleSortChange}
        loading={loading}
        dense
        ariaLabel="فهرست اسناد فروش"
        emptyMessage="سندی یافت نشد. برای ثبت، از دکمه «پیش‌فاکتور جدید» استفاده کنید."
        pagination={
          data
            ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }
            : null
        }
      />
    </div>
  );
}
