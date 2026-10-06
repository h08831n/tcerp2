"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/ui/data-table";
import { ProductsNav } from "@/components/products/nav";
import { StatusBadge } from "@/components/parties/badges";
import { faDigits, jalali } from "@/lib/format";
import {
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABELS,
  fetchAllBrands,
  fetchAllCategories,
  fetchTemplates,
  type ProductType,
  type TemplateListItem,
} from "@/lib/product";

const PAGE_SIZE = 20;

type SortField = "nameFa" | "createdAt";

export default function ProductsPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [brandId, setBrandId] = useState("");
  const [productType, setProductType] = useState<ProductType | "">("");
  const [active, setActive] = useState<"" | "true" | "false">("true");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);

  const [categories, setCategories] = useState<{ id: string; nameFa: string }[]>([]);
  const [brands, setBrands] = useState<{ id: string; nameFa: string }[]>([]);
  const [data, setData] = useState<{ items: TemplateListItem[]; total: number; page: number; pageSize: number } | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    void fetchAllCategories("true")
      .then((items) => {
        if (!cancelled) setCategories(items.map((c) => ({ id: c.id, nameFa: c.nameFa })));
      })
      .catch(() => undefined);
    void fetchAllBrands("true")
      .then((items) => {
        if (!cancelled) setBrands(items.map((b) => ({ id: b.id, nameFa: b.nameFa })));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const query = useMemo(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      categoryId: categoryId || undefined,
      brandId: brandId || undefined,
      productType: productType || undefined,
      active: (active || undefined) as "true" | "false" | undefined,
    }),
    [page, search, categoryId, brandId, productType, active],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchTemplates(query)
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
  }, []);

  // The backend list endpoint has a fixed createdAt ordering; the
  // name/createdAt sorts are applied to the loaded page client-side.
  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
    if (sort?.key === "nameFa") {
      items.sort((a, b) =>
        sort.dir === "asc"
          ? a.nameFa.localeCompare(b.nameFa, "fa")
          : b.nameFa.localeCompare(a.nameFa, "fa"),
      );
    } else if (sort?.key === "createdAt") {
      items.sort((a, b) => {
        const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return sort.dir === "asc" ? diff : -diff;
      });
    }
    return items;
  }, [data, sort]);

  const columns = useMemo<DataTableColumn<TemplateListItem>[]>(
    () => [
      {
        key: "nameFa",
        header: "نام",
        sortable: true,
        render: (row) => (
          <div className="min-w-0">
            <span className="block truncate font-medium text-slate-800">{row.nameFa}</span>
            {row.nameEn && (
              <span className="block truncate text-[11px] text-slate-400" dir="ltr">
                {row.nameEn}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "internalCode",
        header: "کد داخلی",
        render: (row) =>
          row.internalCode ? (
            <span dir="ltr" className="block text-start tabular-nums text-slate-600">
              {row.internalCode}
            </span>
          ) : (
            <span className="text-slate-400">—</span>
          ),
      },
      {
        key: "category",
        header: "گروه",
        render: (row) => row.category?.nameFa ?? <span className="text-slate-400">—</span>,
      },
      {
        key: "brand",
        header: "برند",
        render: (row) => row.brand?.nameFa ?? <span className="text-slate-400">—</span>,
      },
      {
        key: "productType",
        header: "نوع",
        render: (row) => (
          <span className="inline-flex items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
            {PRODUCT_TYPE_LABELS[row.productType] ?? row.productType}
          </span>
        ),
      },
      {
        key: "variantsCount",
        header: "تعداد variants",
        align: "center",
        render: (row) => (
          <span className="tabular-nums">{faDigits(row.variantsCount)}</span>
        ),
      },
      {
        key: "active",
        header: "وضعیت",
        align: "center",
        render: (row) => <StatusBadge archived={!row.active} />,
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
      <ProductsNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">محصولات</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            خانواده‌های محصول، انواع، گروه‌ها و وضعیت
          </p>
        </div>
        <Link href="/products/new" tabIndex={-1}>
          <Button variant="primary" aria-label="ایجاد محصول جدید">
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
            محصول جدید
          </Button>
        </Link>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-64">
          <label htmlFor="product-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (نام، کد داخلی)
          </label>
          <Input
            id="product-search"
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
            placeholder="جستجو…"
            aria-label="جستجوی محصولات"
          />
        </div>

        <div className="w-44">
          <label htmlFor="product-category" className="mb-1 block text-xs font-medium text-slate-600">
            گروه
          </label>
          <select
            id="product-category"
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.nameFa}
              </option>
            ))}
          </select>
        </div>

        <div className="w-44">
          <label htmlFor="product-brand" className="mb-1 block text-xs font-medium text-slate-600">
            برند
          </label>
          <select
            id="product-brand"
            value={brandId}
            onChange={(event) => {
              setBrandId(event.target.value);
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.nameFa}
              </option>
            ))}
          </select>
        </div>

        <div className="w-36">
          <label htmlFor="product-type" className="mb-1 block text-xs font-medium text-slate-600">
            نوع
          </label>
          <select
            id="product-type"
            value={productType}
            onChange={(event) => {
              setProductType(event.target.value as ProductType | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {PRODUCT_TYPES.map((value) => (
              <option key={value} value={value}>
                {PRODUCT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className="w-32">
          <label htmlFor="product-active" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="product-active"
            value={active}
            onChange={(event) => {
              setActive(event.target.value as "" | "true" | "false");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="true">فعال</option>
            <option value="false">بایگانی</option>
            <option value="">همه</option>
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
        <DataTable<TemplateListItem>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          rowHref={(row) => `/products/${row.id}`}
          getRowAriaLabel={(row) => `مشاهده محصول ${row.nameFa}`}
          sort={sort}
          onSortChange={handleSortChange}
          loading={loading}
          dense
          ariaLabel="فهرست محصولات"
          emptyMessage="رکوردی یافت نشد. برای ثبت، از دکمه «محصول جدید» استفاده کنید."
          pagination={
            data
              ? {
                  page: data.page,
                  pageSize: data.pageSize,
                  total: data.total,
                  onPageChange: (next) => {
                    gridFocusedRef.current = false;
                    setPage(next);
                  },
                }
              : null
          }
        />
      </div>
    </div>
  );
}
