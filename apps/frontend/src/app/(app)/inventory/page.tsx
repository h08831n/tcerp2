"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  STOCK_DIRECTION_BADGE_CLASSES,
  STOCK_DIRECTION_LABELS,
} from "@/lib/loading";
import {
  fetchMovements,
  fetchStock,
  fetchWarehouses,
  inventoryErrorMessage,
  type StockMovementRow,
  type StockRow,
  type WarehouseDto,
} from "@/lib/inventory";

type Tab = "stock" | "movements" | "warehouses";

const tabs: { key: Tab; label: string }[] = [
  { key: "stock", label: "موجودی" },
  { key: "movements", label: "گردش‌ها" },
  { key: "warehouses", label: "انبارها" },
];

function StockTab({ warehouses }: { warehouses: WarehouseDto[] }) {
  const [rows, setRows] = useState<StockRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [warehouseId, setWarehouseId] = useState("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchStock({
        page,
        pageSize,
        warehouseId: warehouseId || undefined,
        search: search || undefined,
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(inventoryErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page, warehouseId, search]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<StockRow>[] = [
    {
      key: "variant",
      header: "کالا",
      render: (r) => (
        <div>
          <div className="text-sm font-medium text-slate-800">{r.variant.nameFa}</div>
          <div className="text-xs text-slate-500">{r.variant.sku}</div>
        </div>
      ),
    },
    {
      key: "stock",
      header: "موجودی",
      align: "center",
      render: (r) => (
        <span
          className={`rounded px-2 py-0.5 text-sm font-bold tabular-nums ${
            r.negative ? "bg-rose-100 text-rose-700" : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {faDigits(r.stock)}
        </span>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Input
            aria-label="جستجوی کالا"
            placeholder="جستجوی کالا"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setPage(1), void load())}
          />
        </div>
        <select
          aria-label="انبار"
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
          value={warehouseId}
          onChange={(e) => (setWarehouseId(e.target.value), setPage(1))}
        >
          <option value="">همه انبارها</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.nameFa}
            </option>
          ))}
        </select>
        <Button variant="secondary" onClick={() => void load()}>
          بروزرسانی
        </Button>
      </div>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.variant.id}
        loading={loading}
        emptyMessage="گردش انباری ثبت نشده است"
      />
      <div className="text-xs text-slate-600">
        مجموع {faDigits(total)} کالا — صفحه {faDigits(page)} از {faDigits(Math.max(1, Math.ceil(total / pageSize)))}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          قبلی
        </Button>
        <Button variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          بعدی
        </Button>
      </div>
    </div>
  );
}

function MovementsTab({ warehouses }: { warehouses: WarehouseDto[] }) {
  const [rows, setRows] = useState<StockMovementRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchMovements({ page, pageSize });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(inventoryErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);
  void warehouses;

  const columns: DataTableColumn<StockMovementRow>[] = [
    {
      key: "date",
      header: "تاریخ",
      render: (r) => <span className="text-xs tabular-nums text-slate-700">{jalaliDateTime(r.movementDate)}</span>,
    },
    {
      key: "variant",
      header: "کالا",
      render: (r) => <span className="text-sm text-slate-800">{r.productVariant.nameFa}</span>,
    },
    {
      key: "direction",
      header: "جهت",
      align: "center",
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STOCK_DIRECTION_BADGE_CLASSES[r.direction]}`}>
          {STOCK_DIRECTION_LABELS[r.direction]}
        </span>
      ),
    },
    {
      key: "qty",
      header: "مقدار",
      align: "center",
      render: (r) => (
        <span className="text-sm tabular-nums text-slate-800">
          {faDigits(r.quantity)} <span className="text-xs text-slate-500">{r.uom.symbol}</span>
        </span>
      ),
    },
    {
      key: "source",
      header: "منبع",
      render: (r) => (
        <Link
          href={r.sourceEntityType === "LOADING" ? `/loadings/${r.sourceEntityId}` : `/purchases/${r.sourceEntityId}`}
          className="text-xs text-sky-700 hover:underline"
        >
          {r.sourceEntityType === "LOADING" ? "بارگیری" : "خرید"}
        </Link>
      ),
    },
    {
      key: "warehouse",
      header: "انبار",
      render: (r) => <span className="text-xs text-slate-600">{r.warehouse.nameFa}</span>,
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="space-y-3">
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="گردشی ثبت نشده است"
      />
      <div className="text-xs text-slate-600">
        مجموع {faDigits(total)} گردش — صفحه {faDigits(page)} از {faDigits(totalPages)}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
          قبلی
        </Button>
        <Button variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
          بعدی
        </Button>
      </div>
    </div>
  );
}

function WarehousesTab() {
  const [rows, setRows] = useState<WarehouseDto[]>([]);
  const [code, setCode] = useState("");
  const [nameFa, setNameFa] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setRows(await fetchWarehouses());
    } catch (e) {
      setError(inventoryErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!code.trim() || !nameFa.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await fetch("/api-x", { method: "HEAD" }).catch(() => undefined);
      const { createWarehouse } = await import("@/lib/inventory");
      await createWarehouse({ code: code.trim(), nameFa: nameFa.trim() });
      setCode("");
      setNameFa("");
      await load();
    } catch (e) {
      setError(inventoryErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const setDefault = async (id: string) => {
    setError(null);
    try {
      const { setDefaultWarehouse } = await import("@/lib/inventory");
      await setDefaultWarehouse(id);
      await load();
    } catch (e) {
      setError(inventoryErrorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3">
        <div className="w-32">
          <label className="mb-1 block text-xs font-medium text-slate-600">کد</label>
          <Input value={code} onChange={(e) => setCode(e.target.value)} aria-label="کد انبار" />
        </div>
        <div className="w-56">
          <label className="mb-1 block text-xs font-medium text-slate-600">نام</label>
          <Input value={nameFa} onChange={(e) => setNameFa(e.target.value)} aria-label="نام انبار" />
        </div>
        <Button variant="primary" disabled={busy} onClick={() => void create()}>
          افزودن انبار
        </Button>
      </div>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      <div className="overflow-hidden rounded-lg border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="px-3 py-2 text-right">کد</th>
              <th className="px-3 py-2 text-right">نام</th>
              <th className="px-3 py-2 text-center">پیش‌فرض</th>
              <th className="px-3 py-2 text-center">عملیات</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.id} className="border-t border-slate-100">
                <td className="px-3 py-2">{w.code}</td>
                <td className="px-3 py-2">{w.nameFa}</td>
                <td className="px-3 py-2 text-center">
                  {w.isDefault ? (
                    <span className="rounded bg-sky-100 px-2 py-0.5 text-xs text-sky-700">پیش‌فرض</span>
                  ) : (
                    <Button variant="ghost" onClick={() => void setDefault(w.id)}>
                      پیش‌فرض کن
                    </Button>
                  )}
                </td>
                <td className="px-3 py-2 text-center text-xs text-slate-400">{w.active ? "فعال" : "غیرفعال"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function InventoryPage() {
  const [tab, setTab] = useState<Tab>("stock");
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);

  useEffect(() => {
    void fetchWarehouses()
      .then(setWarehouses)
      .catch(() => undefined);
  }, []);

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">انبار</h1>
      <div role="tablist" aria-label="بخش‌های انبار" className="flex gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                const idx = tabs.findIndex((x) => x.key === tab);
                const next = e.key === "ArrowLeft" ? (idx + 1) % tabs.length : (idx + tabs.length - 1) % tabs.length;
                setTab(tabs[next].key);
              }
            }}
            className={`-mb-px px-4 py-2 text-sm font-medium ${
              tab === t.key
                ? "border-b-2 border-sky-600 text-sky-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === "stock" && <StockTab warehouses={warehouses} />}
      {tab === "movements" && <MovementsTab warehouses={warehouses} />}
      {tab === "warehouses" && <WarehousesTab />}
    </div>
  );
}
