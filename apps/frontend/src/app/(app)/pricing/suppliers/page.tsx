"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { faDigits, jalaliDateTime } from "@/lib/format";
import { fetchAllUoms } from "@/lib/product";
import {
  fetchCheapestSuppliers,
  pricingErrorMessage,
  type CheapestSupplierItem,
} from "@/lib/pricing";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

interface UomOption {
  id: string;
  symbol: string;
  nameFa: string;
}

const columns: DataTableColumn<CheapestSupplierItem>[] = [
  {
    key: "supplier",
    header: "تامین‌کننده",
    render: (row) => <span className="text-sm font-medium text-slate-800">{row.supplierNameFa}</span>,
  },
  {
    key: "uom",
    header: "واحد",
    render: (row) => <span className="text-xs text-slate-600">{row.uomSymbol}</span>,
  },
  {
    key: "winCount",
    header: "تعداد روز کمترین",
    align: "center",
    render: (row) => (
      <span className="rounded border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-bold text-emerald-700 tabular-nums">
        {faDigits(row.winCount)}
      </span>
    ),
  },
  {
    key: "lastWonAt",
    header: "آخرین بار",
    align: "center",
    render: (row) => (
      <span className="text-xs tabular-nums text-slate-600">
        {row.lastWonAt ? jalaliDateTime(row.lastWonAt) : "—"}
      </span>
    ),
  },
];

function CheapestSuppliersReport() {
  const [variant, setVariant] = useState<VariantSelection | null>(null);
  const [days, setDays] = useState("60");
  const [uoms, setUoms] = useState<UomOption[]>([]);
  const [uomId, setUomId] = useState("");
  const [items, setItems] = useState<CheapestSupplierItem[] | null>(null);
  const [reportDays, setReportDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await fetchAllUoms(true);
        setUoms(list.map((uom) => ({ id: uom.id, symbol: uom.symbol, nameFa: uom.nameFa })));
      } catch {
        // Uom filter stays optional; the report still runs without it.
      }
    })();
  }, []);

  const load = useCallback(async () => {
    if (!variant) {
      setError("ابتدا محصول (variant) را انتخاب کنید.");
      return;
    }
    const parsedDays = Number(days);
    if (!Number.isFinite(parsedDays) || parsedDays < 1) {
      setError("تعداد روز باید عددی بزرگ‌تر از صفر باشد.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const report = await fetchCheapestSuppliers({
        variantId: variant.variantId,
        days: Math.trunc(parsedDays),
        ...(uomId ? { uomId } : {}),
      });
      setItems(report.items);
      setReportDays(report.days);
    } catch (err) {
      setError(pricingErrorMessage(err));
      setItems(null);
    } finally {
      setLoading(false);
    }
  }, [variant, days, uomId]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">گزارش کمترین قیمت تامین‌کنندگان</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            در هر روز، تامین‌کننده‌ای که کمترین پیشنهاد را داده شمارش می‌شود (بدون میانگین‌گیری).
          </p>
        </div>
        <Link href="/pricing">
          <Button variant="secondary" size="sm">
            بازگشت به میز کار قیمت
          </Button>
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="min-w-64 flex-1">
          <label className={fieldLabel}>محصول</label>
          <VariantSelector value={variant} onChange={setVariant} />
        </div>
        <div className="w-28">
          <label htmlFor="cheapest-days" className={fieldLabel}>
            بازه (روز)
          </label>
          <Input
            id="cheapest-days"
            inputSize="md"
            dir="ltr"
            inputMode="numeric"
            value={days}
            onChange={(event) => setDays(event.target.value)}
            aria-label="بازه گزارش به روز"
          />
        </div>
        <div className="w-40">
          <label htmlFor="cheapest-uom" className={fieldLabel}>
            واحد (اختیاری)
          </label>
          <select
            id="cheapest-uom"
            value={uomId}
            onChange={(event) => setUomId(event.target.value)}
            className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه واحدها</option>
            {uoms.map((uom) => (
              <option key={uom.id} value={uom.id}>
                {uom.symbol} — {uom.nameFa}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={() => void load()} disabled={loading} aria-label="نمایش گزارش">
          {loading ? "در حال محاسبه…" : "نمایش گزارش"}
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {items && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            بازه: {faDigits(reportDays ?? 60)} روز گذشته
            {variant ? ` — ${variant.label}` : ""}
          </p>
          <DataTable<CheapestSupplierItem>
            columns={columns}
            rows={items}
            rowKey={(row) => `${row.supplierPartyId}-${row.uomId}`}
            loading={loading}
            ariaLabel="گزارش کمترین قیمت تامین‌کنندگان"
            emptyMessage="در این بازه پیشنهاد قیمت ثبت نشده است."
          />
        </div>
      )}
    </div>
  );
}

export default function CheapestSuppliersPage() {
  return <CheapestSuppliersReport />;
}
