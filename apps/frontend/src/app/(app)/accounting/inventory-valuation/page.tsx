"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, faMoneyExact } from "@/lib/format";
import {
  accountingErrorMessage,
  fetchInventoryValuation,
  type ValuationReport,
  type ValuationRow,
} from "@/lib/accounting";
import { fetchWarehouses, type WarehouseDto } from "@/lib/inventory";

/** ارزش‌گذاری موجودی — LEGS model with exact-decimal grand total. */
export default function InventoryValuationPage() {
  const [search, setSearch] = useState("");
  const [warehouses, setWarehouses] = useState<WarehouseDto[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [rows, setRows] = useState<ValuationRow[]>([]);
  const [grand, setGrand] = useState<ValuationReport["totals"] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const pageSize = 25;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const report = await fetchInventoryValuation({
        search: search || undefined,
        warehouseId: warehouseId || undefined,
        page,
        pageSize,
      });
      setRows(report.rows);
      setGrand(report.totals);
      setTotal(report.total);
    } catch (e) {
      setError(accountingErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [search, warehouseId, page]);

  useEffect(() => {
    fetchWarehouses()
      .then((ws) => setWarehouses(Array.isArray(ws) ? ws : []))
      .catch(() => setWarehouses([])); // filter chrome only
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: DataTableColumn<ValuationRow>[] = [
    {
      key: "variant",
      header: "کالا",
      render: (r) => (
        <div>
          <div className="text-sm font-medium text-slate-800">{r.variant.nameFa}</div>
          <div className="text-xs text-slate-400">{r.variant.sku}</div>
        </div>
      ),
    },
    { key: "category", header: "گروه", render: (r) => r.categoryNameFa ?? "—" },
    { key: "warehouse", header: "انبار", render: (r) => r.warehouseNameFa ?? "—" },
    {
      key: "quantity",
      header: "موجودی",
      render: (r) => (
        <span className={r.negative ? "text-rose-700" : undefined}>
          {faMoneyExact(r.quantity)}
          {r.uomSymbol ? ` ${faDigits(r.uomSymbol)}` : ""}
        </span>
      ),
    },
    { key: "unitCost", header: "بهای واحد", render: (r) => faMoneyExact(r.unitCost) },
    { key: "totalValue", header: "ارزش کل", render: (r) => faMoneyExact(r.totalValue) },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">انبار</label>
          <select
            value={warehouseId}
            onChange={(e) => {
              setPage(1);
              setWarehouseId(e.target.value);
            }}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            <option value="">همه انبارها</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.nameFa}
              </option>
            ))}
          </select>
        </div>
        <div className="flex-1">
          <label className="mb-1 block text-xs text-slate-500">جستجو</label>
          <Input
            value={search}
            onChange={(e) => {
              setPage(1);
              setSearch(e.target.value);
            }}
            placeholder="نام کالا یا SKU"
          />
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}

      {grand && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="text-xs text-slate-500">جمع کل موجودی (مستقل از صفحه‌بندی)</div>
            <div className="mt-1 text-sm font-semibold tabular-nums">{faMoneyExact(grand.grandQuantity)}</div>
          </div>
          <div className="rounded-lg border border-teal-200 bg-teal-50 p-4">
            <div className="text-xs text-teal-700">ارزش کل موجودی (مستقل از صفحه‌بندی)</div>
            <div className="mt-1 text-sm font-semibold tabular-nums text-teal-900">
              {faMoneyExact(grand.grandTotalValue)}
            </div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.variant.id + ":" + r.warehouseNameFa}
        loading={loading}
        emptyMessage="موجودی قابل ارزش‌گذاری یافت نشد."
        dense
      />

      {total > pageSize && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            قبلی
          </Button>
          <span className="text-slate-500">
            صفحه {faDigits(page)} از {faDigits(Math.max(1, Math.ceil(total / pageSize)))}
          </span>
          <Button
            variant="secondary"
            disabled={page >= Math.ceil(total / pageSize)}
            onClick={() => setPage((p) => p + 1)}
          >
            بعدی
          </Button>
        </div>
      )}
    </div>
  );
}
