"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, faMoney, jalali, thousandSeparate, toNum } from "@/lib/format";
import {
  DAILY_PRICE_SOURCE_LABELS,
  fetchDailyHistory,
  pricingErrorMessage,
  type DailyPriceHistoryRow,
} from "@/lib/pricing";

interface HistoryRow extends DailyPriceHistoryRow {
  delta: number | null;
  deltaPercent: number | null;
}

function DeltaCell({ row }: { row: HistoryRow }) {
  const delta = row.delta;
  if (delta === null || delta === 0) {
    return <span className="text-slate-300">—</span>;
  }
  const percent =
    row.deltaPercent !== null
      ? Number.isInteger(row.deltaPercent)
        ? String(row.deltaPercent)
        : row.deltaPercent.toFixed(1)
      : null;
  if (delta > 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
        <span aria-hidden="true">▲</span>
        {faDigits(thousandSeparate(delta))}
        {percent !== null ? ` (${faDigits(percent)}٪)` : ""}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
      <span aria-hidden="true">▼</span>
      {faDigits(thousandSeparate(Math.abs(delta)))}
      {percent !== null ? ` (${faDigits(percent)}٪)` : ""}
    </span>
  );
}

const columns: DataTableColumn<HistoryRow>[] = [
  {
    key: "date",
    header: "تاریخ",
    render: (row) => (
      <span className="text-xs font-semibold tabular-nums text-slate-800">{jalali(row.date)}</span>
    ),
  },
  {
    key: "price",
    header: "قیمت",
    render: (row) => <span className="text-xs tabular-nums">{faMoney(toNum(row.price))}</span>,
  },
  {
    key: "delta",
    header: "تغییر نسبت به روز قبل",
    render: (row) => <DeltaCell row={row} />,
  },
  {
    key: "uom",
    header: "واحد",
    render: (row) => <span className="text-xs text-slate-600">{row.uom?.symbol ?? "—"}</span>,
  },
  {
    key: "supplier",
    header: "تامین‌کننده",
    render: (row) => <span className="text-xs text-slate-600">{row.supplier?.nameFa ?? "—"}</span>,
  },
  {
    key: "source",
    header: "منبع",
    render: (row) => (
      <span className="text-[11px] text-slate-500">
        {DAILY_PRICE_SOURCE_LABELS[row.source] ?? row.source}
      </span>
    ),
  },
  {
    key: "enteredBy",
    header: "ثبت‌کننده",
    render: (row) =>
      row.enteredBy ? (
        <span dir="ltr" title={row.enteredBy} className="font-mono text-[10px] text-slate-400">
          {row.enteredBy.slice(0, 8)}
        </span>
      ) : (
        <span className="text-slate-300">—</span>
      ),
  },
  {
    key: "notes",
    header: "یادداشت",
    render: (row) => <span className="text-[11px] text-slate-500">{row.notes ?? "—"}</span>,
  },
];

function HistoryContent() {
  const params = useParams<{ variantId: string }>();
  const variantId = typeof params?.variantId === "string" ? params.variantId : "";
  const search = useSearchParams();
  const variantName = search?.get("name") ?? "";
  const variantSku = search?.get("sku") ?? "";

  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!variantId) return;
    setLoading(true);
    setError(null);
    try {
      const history = await fetchDailyHistory(variantId);
      // Backend returns newest first; delta compares each row with the newer day.
      const enriched: HistoryRow[] = history.map((row, index) => {
        const newer = index > 0 ? history[index - 1] : null;
        const price = toNum(row.price);
        const newerPrice = newer ? toNum(newer.price) : null;
        const delta = price !== null && newerPrice !== null ? price - newerPrice : null;
        return {
          ...row,
          delta,
          deltaPercent:
            delta !== null && newerPrice !== null && newerPrice !== 0
              ? (delta / newerPrice) * 100
              : null,
        };
      });
      setRows(enriched);
    } catch (err) {
      setError(pricingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [variantId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">تاریخچه قیمت</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {variantName
              ? `${variantName}${variantSku ? ` — ${variantSku}` : ""}`
              : "قیمت‌های ثبت‌شده این محصول، جدیدترین اول"}
            {" — "}قیمت روزهای گذشته تغییرناپذیر است و اصلاحات با ممیزی ثبت می‌شود.
          </p>
        </div>
        <Link href="/pricing">
          <Button variant="secondary" size="sm">
            بازگشت به میز کار قیمت
          </Button>
        </Link>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <DataTable<HistoryRow>
        columns={columns}
        rows={rows}
        rowKey={(row) => `${row.id}-${row.uomId}`}
        loading={loading}
        dense
        ariaLabel="تاریخچه قیمت"
        emptyMessage="برای این محصول قیمتی ثبت نشده است."
      />
    </div>
  );
}

export default function PriceHistoryPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-400">در حال بارگذاری…</p>}>
      <HistoryContent />
    </Suspense>
  );
}
