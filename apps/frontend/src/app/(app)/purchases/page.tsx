"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PurchaseStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali, toNum, thousandSeparate } from "@/lib/format";
import {
  PURCHASE_STATUSES,
  PURCHASE_STATUS_LABELS,
  fetchPurchases,
  purchaseErrorMessage,
  type PurchaseDocumentListItem,
  type PurchaseStatus,
} from "@/lib/purchase";

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

export default function PurchasesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<PurchaseStatus | "">("");
  const [supplier, setSupplier] = useState<EntityOption | null>(null);
  const [buyer, setBuyer] = useState<EntityOption | null>(null);
  const [page, setPage] = useState(1);

  const [data, setData] = useState<{
    items: PurchaseDocumentListItem[];
    total: number;
    page: number;
    pageSize: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

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
      supplierPartyId: supplier?.id,
      buyerUserId: buyer?.id,
    }),
    [page, search, status, supplier, buyer],
  );

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchPurchases(query)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(purchaseErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => load(), [load, reloadToken]);

  const columns = useMemo<DataTableColumn<PurchaseDocumentListItem>[]>(
    () => [
      {
        key: "documentNumber",
        header: "شماره PO",
        render: (row) => (
          <span dir="ltr" className="block text-start font-medium text-primary-700">
            {row.documentNumber}
          </span>
        ),
      },
      { key: "supplier", header: "تامین‌کننده", render: (row) => row.supplier?.nameFa ?? "—" },
      { key: "buyer", header: "خریدار", render: (row) => row.buyer?.name ?? "—" },
      {
        key: "documentDate",
        header: "تاریخ",
        render: (row) => (
          <span className="tabular-nums text-slate-500">{jalali(row.documentDate)}</span>
        ),
      },
      {
        key: "status",
        header: "وضعیت",
        align: "center",
        render: (row) => <PurchaseStatusBadge status={row.status} />,
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
          <h2 className="text-lg font-bold text-slate-800">اسناد خرید</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            سفارش‌های خرید — مستقل از فروش؛ کل شرکت دید دارند
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link href="/allocations" tabIndex={-1}>
            <Button variant="secondary" aria-label="تخصیص بار">
              تخصیص بار
            </Button>
          </Link>
          <Link href="/purchases/new" tabIndex={-1}>
            <Button variant="primary" aria-label="ایجاد سند خرید جدید">
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
              سند خرید جدید
            </Button>
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-52">
          <label htmlFor="purchase-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (شماره سند، تامین‌کننده)
          </label>
          <Input
            id="purchase-search"
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
            placeholder="PO-1405-…"
            aria-label="جستجوی اسناد خرید"
          />
        </div>
        <div className="w-40">
          <label htmlFor="purchase-status" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="purchase-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as PurchaseStatus | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {PURCHASE_STATUSES.map((value) => (
              <option key={value} value={value}>
                {PURCHASE_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="w-52">
          <label className="mb-1 block text-xs font-medium text-slate-600">تامین‌کننده</label>
          <EntitySelector
            endpoint={(q) => `/parties?role=SUPPLIER&search=${encodeURIComponent(q)}&pageSize=10`}
            mapItem={partyMapItem}
            value={supplier}
            onChange={(next) => {
              setSupplier(next);
              setPage(1);
            }}
            placeholder="همه تامین‌کنندگان"
            ariaLabel="فیلتر تامین‌کننده"
            emptySearchLabel="برای جستجو تایپ کنید"
          />
        </div>
        <div className="w-52">
          <label className="mb-1 block text-xs font-medium text-slate-600">خریدار</label>
          <EntitySelector
            endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
            mapItem={userMapItem}
            value={buyer}
            onChange={(next) => {
              setBuyer(next);
              setPage(1);
            }}
            placeholder="همه خریداران"
            ariaLabel="فیلتر خریدار"
            emptySearchLabel="برای جستجو تایپ کنید"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}{" "}
          <button type="button" className="font-bold underline" onClick={() => setReloadToken((t) => t + 1)}>
            تلاش مجدد
          </button>
        </div>
      )}

      <DataTable<PurchaseDocumentListItem>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        rowHref={(row) => `/purchases/${row.id}`}
        getRowAriaLabel={(row) => `مشاهده سند خرید ${row.documentNumber}`}
        loading={loading}
        dense
        ariaLabel="فهرست اسناد خرید"
        emptyMessage="سندی یافت نشد. برای ثبت، از دکمه «سند خرید جدید» استفاده کنید."
        pagination={
          data
            ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }
            : null
        }
      />
    </div>
  );
}
