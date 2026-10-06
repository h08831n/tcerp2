"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/ui/data-table";
import { RoleBadge, ScoreBadge, TypeBadge } from "@/components/parties/badges";
import { faDigits, jalali } from "@/lib/format";
import {
  PARTY_ROLE_LABELS,
  PARTY_TYPE_LABELS,
  fetchParties,
  PARTY_ROLES,
  type PartyListItem,
  type PartyListQuery,
  type PartyListResponse,
  type PartyRole,
  type PartyType,
} from "@/lib/party";

const PAGE_SIZE = 20;

type SortField = "nameFa" | "createdAt" | "score";

export default function PartiesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState<PartyType | "">("");
  const [role, setRole] = useState<PartyRole | "">("");
  const [archived, setArchived] = useState<"false" | "true">("false");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>({
    key: "createdAt",
    dir: "desc",
  });

  const [data, setData] = useState<PartyListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const gridFocusedRef = useRef(false);

  // Debounced search: applies 400ms after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      const term = searchInput.trim();
      setSearch((current) => {
        if (current !== term) setPage(1);
        return term;
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo<PartyListQuery>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      type: type || undefined,
      role: role || undefined,
      archived: archived === "true",
      sort: (sort?.key as SortField) || undefined,
      dir: sort?.dir,
    }),
    [page, search, type, role, archived, sort],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchParties(query)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "خطا در دریافت فهرست");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query, reloadToken]);

  // Focus the grid on mount / after data load so arrows work immediately.
  useEffect(() => {
    if (loading || gridFocusedRef.current) return;
    const firstRow = tableWrapRef.current?.querySelector<HTMLTableRowElement>("tbody tr[tabindex]");
    if (firstRow) {
      firstRow.focus();
      gridFocusedRef.current = true;
    }
  }, [loading, data]);

  const handleSortChange = useCallback((next: DataTableSort) => {
    setSort(next);
    setPage(1);
  }, []);

  const columns = useMemo<DataTableColumn<PartyListItem>[]>(
    () => [
      {
        key: "nameFa",
        header: "نام",
        sortable: true,
        render: (row) => (
          <div className="flex items-center gap-2">
            <span className="font-medium text-slate-800">{row.nameFa}</span>
            {row.archived && (
              <span className="rounded border border-red-200 bg-red-50 px-1 text-[10px] text-red-600">
                بایگانی
              </span>
            )}
          </div>
        ),
      },
      {
        key: "type",
        header: "نوع",
        render: (row) => <TypeBadge type={row.type} />,
      },
      {
        key: "roles",
        header: "نقش‌ها",
        render: (row) =>
          row.roles.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {row.roles.map((item) => (
                <RoleBadge key={item} role={item} />
              ))}
            </div>
          ) : (
            <span className="text-slate-400">—</span>
          ),
      },
      {
        key: "primaryPhone",
        header: "موبایل اصلی",
        render: (row) => (
          <span dir="ltr" className="block text-start tabular-nums">
            {row.primaryPhone ? faDigits(row.primaryPhone.normalizedValue) : "—"}
          </span>
        ),
      },
      {
        key: "internalCode",
        header: "کد داخلی",
        render: (row) => (row.internalCode ? faDigits(row.internalCode) : "—"),
      },
      {
        key: "owner",
        header: "مالک",
        render: (row) => row.owner?.name ?? "—",
      },
      {
        key: "score",
        header: "امتیاز",
        sortable: true,
        align: "center",
        render: (row) => <ScoreBadge score={row.score} level={row.scoreLevel} />,
      },
      {
        key: "createdAt",
        header: "تاریخ ایجاد",
        sortable: true,
        render: (row) => (
          <span className="tabular-nums text-slate-500">{jalali(row.createdAt)}</span>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">مشتریان و تامین‌کنندگان</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            مدیریت اشخاص و شرکت‌ها، نقش‌ها، تماس‌ها و امتیاز
          </p>
        </div>
        <Link href="/parties/new" tabIndex={-1}>
          <Button variant="primary" aria-label="ایجاد مشتری جدید">
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
            مشتری جدید
          </Button>
        </Link>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-72">
          <label htmlFor="party-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (نام، کد، موبایل)
          </label>
          <div className="flex gap-2">
            <Input
              id="party-search"
              inputSize="sm"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  const term = searchInput.trim();
                  setSearch(term);
                  setPage(1);
                }
              }}
              placeholder="جستجو…"
              aria-label="جستجوی مشتریان"
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setSearch(searchInput.trim());
                setPage(1);
              }}
              aria-label="اجرای جستجو"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" />
              </svg>
              جستجو
            </Button>
          </div>
        </div>

        <div className="w-40">
          <label htmlFor="party-type" className="mb-1 block text-xs font-medium text-slate-600">
            نوع
          </label>
          <select
            id="party-type"
            value={type}
            onChange={(event) => {
              setType(event.target.value as PartyType | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {(Object.keys(PARTY_TYPE_LABELS) as PartyType[]).map((value) => (
              <option key={value} value={value}>
                {PARTY_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="w-40">
          <label htmlFor="party-role" className="mb-1 block text-xs font-medium text-slate-600">
            نقش
          </label>
          <select
            id="party-role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as PartyRole | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {PARTY_ROLES.map((value) => (
              <option key={value} value={value}>
                {PARTY_ROLE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="w-40">
          <label htmlFor="party-archived" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="party-archived"
            value={archived}
            onChange={(event) => {
              setArchived(event.target.value as "true" | "false");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="false">فعال</option>
            <option value="true">بایگانی‌شده</option>
          </select>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
        >
          {error}{" "}
          <button
            type="button"
            className="font-bold underline"
            onClick={() => setReloadToken((token) => token + 1)}
          >
            تلاش مجدد
          </button>
        </div>
      )}

      <div ref={tableWrapRef}>
        <DataTable<PartyListItem>
          columns={columns}
          rows={data?.items ?? []}
          rowKey={(row) => row.id}
          rowHref={(row) => `/parties/${row.id}`}
          getRowAriaLabel={(row) => `مشاهده پرونده ${row.nameFa}`}
          sort={sort}
          onSortChange={handleSortChange}
          loading={loading}
          dense
          ariaLabel="فهرست مشتریان و تامین‌کنندگان"
          emptyMessage="رکوردی یافت نشد. برای ثبت، از دکمه «مشتری جدید» استفاده کنید."
          pagination={
            data
              ? {
                  page: data.page,
                  pageSize: data.pageSize,
                  total: data.total,
                  onPageChange: setPage,
                }
              : null
          }
        />
      </div>
    </div>
  );
}
