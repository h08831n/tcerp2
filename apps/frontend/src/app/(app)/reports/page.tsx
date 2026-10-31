"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  decideOfferOutcome,
  deleteSavedView,
  fetchDebtReport,
  fetchOffersOutcome,
  fetchWarehouseNegative,
  fetchWarehouseTurnover,
  loadSavedViews,
  saveView,
  type DebtReportItem,
  type OffersOutcomeReport,
  type SavedView,
  type WarehouseNegativeStockItem,
  type WarehouseTurnoverItem,
} from "@/lib/reports";

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${faDigits(new Intl.NumberFormat("fa-IR").format(Math.round(value)))} ریال`;
}

type Tab = "debt" | "offers" | "stock";

export default function ReportsPage() {
  const [tab, setTab] = useState<Tab>("debt");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noPermission, setNoPermission] = useState(false);

  // ── debt ──
  const [debtRole, setDebtRole] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");
  const [debtSearch, setDebtSearch] = useState("");
  const [debt, setDebt] = useState<DebtReportItem[]>([]);
  const [debtGroupTotal, setDebtGroupTotal] = useState(0);
  const [debtLoading, setDebtLoading] = useState(false);
  const [debtViews, setDebtViews] = useState<SavedView[]>([]);
  const [viewName, setViewName] = useState("");

  // ── offers ──
  const [offers, setOffers] = useState<OffersOutcomeReport | null>(null);
  const [offersLoading, setOffersLoading] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  // ── stock ──
  const [negative, setNegative] = useState<WarehouseNegativeStockItem[]>([]);
  const [turnover, setTurnover] = useState<WarehouseTurnoverItem[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [stockLoading, setStockLoading] = useState(false);
  const [stockViews, setStockViews] = useState<SavedView[]>([]);
  const [stockViewName, setStockViewName] = useState("");

  const loadDebt = useCallback(async () => {
    setDebtLoading(true);
    setError(null);
    setNoPermission(false);
    try {
      const res = await fetchDebtReport(debtRole, debtSearch);
      setDebt(res.items);
      setDebtGroupTotal(res.groupTotal);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("FORBIDDEN") || message.includes("403")) setNoPermission(true);
      else setError(message);
    } finally {
      setDebtLoading(false);
    }
  }, [debtRole, debtSearch]);

  const loadOffers = useCallback(async () => {
    setOffersLoading(true);
    setError(null);
    try {
      setOffers(await fetchOffersOutcome());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOffersLoading(false);
    }
  }, []);

  const loadStock = useCallback(async () => {
    setStockLoading(true);
    setError(null);
    try {
      const [neg, turn] = await Promise.all([
        fetchWarehouseNegative(),
        fetchWarehouseTurnover(from || undefined, to || undefined),
      ]);
      setNegative(neg);
      setTurnover(turn);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStockLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    setDebtViews(loadSavedViews(`debt:${debtRole}`));
  }, [debtRole]);

  useEffect(() => {
    setStockViews(loadSavedViews("stock"));
  }, []);

  useEffect(() => {
    if (tab === "debt") void loadDebt();
    if (tab === "offers") void loadOffers();
    if (tab === "stock") void loadStock();
  }, [tab, loadDebt, loadOffers, loadStock]);

  // ── actions ──
  const decide = async (offerId: string, outcome: "WON" | "LOST") => {
    setDecidingId(offerId);
    setError(null);
    try {
      await decideOfferOutcome(offerId, outcome);
      setNotice("تصمیم ثبت شد.");
      await loadOffers();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDecidingId(null);
    }
  };

  const applyView = (view: SavedView, scope: "debt" | "stock") => {
    if (scope === "debt") setDebtSearch(view.filters.search ?? "");
    if (scope === "stock") {
      setFrom(view.filters.from ?? "");
      setTo(view.filters.to ?? "");
    }
  };

  const storeView = (scope: "debt" | "stock") => {
    const name = (scope === "debt" ? viewName : stockViewName).trim();
    if (!name) return;
    if (scope === "debt") {
      saveView(`debt:${debtRole}`, name, { search: debtSearch });
      setDebtViews(loadSavedViews(`debt:${debtRole}`));
      setViewName("");
    } else {
      saveView("stock", name, { from, to });
      setStockViews(loadSavedViews("stock"));
      setStockViewName("");
    }
    setNotice(`نمای «${name}» ذخیره شد.`);
  };

  // ── columns ──
  const debtColumns: DataTableColumn<DebtReportItem>[] = [
    { key: "name", header: "طرف‌حساب", render: (r) => (
      <Link href={`/parties/${r.partyId}`} className="text-sm text-sky-700 hover:underline">
        {r.nameFa}
      </Link>
    ) },
    {
      key: "accounting",
      header: "مانده حسابداری",
      align: "center",
      render: (r) => <span className="text-xs tabular-nums">{money(r.accountingBalance)}</span>,
    },
    {
      key: "operational",
      header: "مانده عملیاتی",
      align: "center",
      render: (r) => <span className="text-xs tabular-nums">{money(r.operationalBalance)}</span>,
    },
    {
      key: "delta",
      header: "اختلاف",
      align: "center",
      render: (r) =>
        r.reconciliationDelta === null ? (
          <span className="text-xs text-slate-400">—</span>
        ) : (
          <span className={`text-xs tabular-nums font-bold ${r.reconciliationDelta !== 0 ? "text-rose-600" : "text-emerald-700"}`}>
            {money(r.reconciliationDelta)}
          </span>
        ),
    },
    {
      key: "claims",
      header: "تسویه معلق",
      align: "center",
      render: (r) =>
        r.unmatchedClaims.count > 0 ? (
          <span className="text-xs text-amber-700">
            {faDigits(r.unmatchedClaims.count)} — {money(r.unmatchedClaims.total)}
          </span>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        ),
    },
    {
      key: "checks",
      header: "چک وصول‌نشده",
      align: "center",
      render: (r) =>
        r.unsettledChecks.count > 0 ? (
          <div className="text-xs">
            <span className="tabular-nums">{faDigits(r.unsettledChecks.count)} — {money(r.unsettledChecks.total)}</span>
            {r.unsettledChecks.nearestDueDate && (
              <p className="text-[10px] text-slate-400">{jalaliDateTime(r.unsettledChecks.nearestDueDate)}</p>
            )}
          </div>
        ) : (
          <span className="text-xs text-slate-300">—</span>
        ),
    },
  ];

  const offersColumns: DataTableColumn<NonNullable<OffersOutcomeReport>["recent"][number]>[] = [
    { key: "request", header: "درخواست قیمت", render: (r) => (
      <Link href={`/price-requests/${r.requestId}`} className="text-xs text-sky-700 hover:underline" dir="ltr">
        {r.requestNumber}
      </Link>
    ) },
    { key: "supplier", header: "تأمین‌کننده", render: (r) => <span className="text-sm">{r.supplierName}</span> },
    { key: "price", header: "قیمت پیشنهادی", align: "center", render: (r) => <span className="text-xs tabular-nums">{money(r.offeredPrice)}</span> },
    {
      key: "outcome",
      header: "نتیجه",
      align: "center",
      render: (r) =>
        r.outcome === "WON" ? (
          <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">برنده</span>
        ) : r.outcome === "LOST" ? (
          <span className="rounded bg-rose-100 px-2 py-0.5 text-xs text-rose-800">بازنده</span>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
    {
      key: "decidedAt",
      header: "تاریخ تصمیم",
      render: (r) => (
        <span className="text-xs tabular-nums text-slate-600">
          {r.decidedAt ? jalaliDateTime(r.decidedAt) : "—"}
        </span>
      ),
    },
    {
      key: "actions",
      header: "تصمیم",
      align: "center",
      render: (r) => (
        <div className="flex justify-center gap-1">
          <Button size="sm" variant="ghost" disabled={decidingId === r.offerId} onClick={() => void decide(r.offerId, "WON")}>
            برنده
          </Button>
          <Button size="sm" variant="ghost" disabled={decidingId === r.offerId} onClick={() => void decide(r.offerId, "LOST")}>
            بازنده
          </Button>
        </div>
      ),
    },
  ];

  const negativeColumns: DataTableColumn<WarehouseNegativeStockItem>[] = [
    { key: "warehouse", header: "انبار", render: (r) => <span className="text-xs">{r.warehouseName ?? "—"}</span> },
    { key: "sku", header: "کد کالا", render: (r) => <span dir="ltr" className="font-mono text-xs">{r.sku}</span> },
    { key: "variant", header: "کالا", render: (r) => <span className="text-sm">{r.variantName}</span> },
    {
      key: "balance",
      header: "تراز",
      align: "center",
      render: (r) => <span className="text-xs tabular-nums font-bold text-rose-600">{faDigits(r.balance)}</span>,
    },
  ];

  const turnoverColumns: DataTableColumn<WarehouseTurnoverItem>[] = [
    { key: "warehouse", header: "انبار", render: (r) => <span className="text-xs">{r.warehouseName ?? "—"}</span> },
    { key: "sku", header: "کد کالا", render: (r) => <span dir="ltr" className="font-mono text-xs">{r.sku}</span> },
    { key: "variant", header: "کالا", render: (r) => <span className="text-sm">{r.variantName}</span> },
    { key: "in", header: "ورودی دوره", align: "center", render: (r) => <span className="text-xs tabular-nums text-emerald-700">{faDigits(r.inQty)}</span> },
    { key: "out", header: "خروجی دوره", align: "center", render: (r) => <span className="text-xs tabular-nums text-rose-700">{faDigits(r.outQty)}</span> },
    { key: "ending", header: "تراز پایان", align: "center", render: (r) => <span className="text-xs tabular-nums font-bold">{faDigits(r.endingBalance)}</span> },
  ];

  const tabs: Array<{ key: Tab; label: string }> = [
    { key: "debt", label: "بدهی طرف‌حساب‌ها" },
    { key: "offers", label: "برد/باخت پیشنهادها" },
    { key: "stock", label: "انبار" },
  ];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">گزارش‌های مدیریتی</h1>

      <div className="flex gap-1 border-b border-slate-200">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`rounded-t-md px-3 py-1.5 text-sm ${
              tab === t.key ? "border-b-2 border-primary-600 font-bold text-primary-700" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}
      {noPermission && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          مشاهده مانده حسابداری نیازمند مجوز «accounting.report» است.
        </div>
      )}

      {tab === "debt" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm"
              value={debtRole}
              onChange={(e) => setDebtRole(e.target.value as "CUSTOMER" | "SUPPLIER")}
            >
              <option value="CUSTOMER">مشتریان (دریافتنی)</option>
              <option value="SUPPLIER">تأمین‌کنندگان (پرداختنی)</option>
            </select>
            <Input
              value={debtSearch}
              onChange={(e) => setDebtSearch(e.target.value)}
              placeholder="جست‌وجوی نام…"
              className="max-w-48"
            />
            <Button size="sm" variant="secondary" onClick={() => void loadDebt()}>
              اعمال
            </Button>
            <Input value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="نام نمای ذخیره‌شونده" className="max-w-40" />
            <Button size="sm" variant="ghost" disabled={!viewName.trim()} onClick={() => storeView("debt")}>
              ذخیره نما
            </Button>
            {debtViews.map((v) => (
              <span key={v.name} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                <button type="button" onClick={() => applyView(v, "debt")} className="hover:underline">
                  {v.name}
                </button>
                <button type="button" aria-label={`حذف نمای ${v.name}`} onClick={() => { deleteSavedView(`debt:${debtRole}`, v.name); setDebtViews(loadSavedViews(`debt:${debtRole}`)); }}>
                  ×
                </button>
              </span>
            ))}
          </div>
          {!noPermission && (
            <p className="text-xs text-slate-500">
              جمع کل گروه: {money(debtGroupTotal)}
            </p>
          )}
          {!noPermission && (
            <DataTable columns={debtColumns} rows={debt} rowKey={(r) => r.partyId} loading={debtLoading} emptyMessage="موردی برای نمایش نیست" />
          )}
        </div>
      )}

      {tab === "offers" && (
        <div className="space-y-5">
          {offers && offers.perSupplier.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-sm font-bold text-slate-700">خلاصه به تفکیک تأمین‌کننده</h2>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {offers.perSupplier.map((s) => (
                  <div key={s.partyId} className="rounded-md border border-slate-200 bg-white p-3">
                    <p className="text-sm font-medium text-slate-800">{s.supplierName}</p>
                    <p className="mt-1 text-xs text-slate-600">
                      برنده {faDigits(s.won)} از {faDigits(s.won + s.lost)} — نرخ {faDigits(s.winRate)}٪
                    </p>
                    <p className="text-[11px] text-slate-400">میانگین قیمت: {money(s.avgOfferedPrice)}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
          <section className="space-y-2">
            <h2 className="text-sm font-bold text-slate-700">آخرین تصمیم‌ها</h2>
            <DataTable columns={offersColumns} rows={offers?.recent ?? []} rowKey={(r) => r.offerId} loading={offersLoading} emptyMessage="تصمیمی ثبت نشده است" />
          </section>
        </div>
      )}

      {tab === "stock" && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-600">
              از
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="ms-1 w-36" />
            </label>
            <label className="text-xs text-slate-600">
              تا
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="ms-1 w-36" />
            </label>
            <Button size="sm" variant="secondary" onClick={() => void loadStock()}>
              اعمال
            </Button>
            <Input value={stockViewName} onChange={(e) => setStockViewName(e.target.value)} placeholder="نام نمای ذخیره‌شونده" className="max-w-40" />
            <Button size="sm" variant="ghost" disabled={!stockViewName.trim()} onClick={() => storeView("stock")}>
              ذخیره نما
            </Button>
            {stockViews.map((v) => (
              <span key={v.name} className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                <button type="button" onClick={() => applyView(v, "stock")} className="hover:underline">
                  {v.name}
                </button>
                <button type="button" aria-label={`حذف نمای ${v.name}`} onClick={() => { deleteSavedView("stock", v.name); setStockViews(loadSavedViews("stock")); }}>
                  ×
                </button>
              </span>
            ))}
          </div>

          <section className="space-y-2">
            <h2 className="text-sm font-bold text-slate-700">موجودی منفی به تفکیک انبار</h2>
            <DataTable columns={negativeColumns} rows={negative} rowKey={(r) => `${r.warehouseId ?? "w"}-${r.variantId}`} loading={stockLoading} emptyMessage="موجودی منفی نیست" />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-bold text-slate-700">گردش انبار (دوره)</h2>
            <DataTable columns={turnoverColumns} rows={turnover} rowKey={(r) => `${r.warehouseId ?? "w"}-${r.variantId}`} loading={stockLoading} emptyMessage="گردشی در این دوره ثبت نشده است" />
          </section>
        </div>
      )}
    </div>
  );
}
