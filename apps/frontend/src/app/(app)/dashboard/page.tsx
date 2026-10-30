"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/ui/modal";
import { faDigits } from "@/lib/format";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

// ───────────────────────── types ─────────────────────────

interface DashboardData {
  date: string;
  sales: {
    openQuotations: number;
    openQuotationTotal: number;
    openOrders: number;
    openOrderTotal: number;
    completedThisMonth: number;
    completedThisMonthTotal: number;
  };
  purchase: {
    openOrders: number;
    openOrderTotal: number;
    completedThisMonth: number;
    completedThisMonthTotal: number;
  };
  loadings: { todayCount: number; pendingDriverRelease: number; reversedThisMonth: number };
  customers: { inactiveCount: number };
  inventory: { negativeStockVariants: number };
}

interface PendingOrderItem {
  documentId: string;
  documentNumber: string;
  status: string;
  total: number;
  customerName: string;
  salesperson: string;
  ageDays: number;
}

interface InactiveCustomerItem {
  partyId: string;
  nameFa: string;
  daysSinceLastPurchase: number | null;
  hasMobile: boolean;
}

interface SearchResults {
  parties: Array<{ id: string; label: string; type: string }>;
  variants: Array<{ id: string; label: string }>;
  salesDocuments: Array<{ id: string; label: string; status: string; total: number }>;
  purchaseDocuments: Array<{ id: string; label: string; status: string; total: number }>;
}

const EMPTY_SEARCH: SearchResults = {
  parties: [],
  variants: [],
  salesDocuments: [],
  purchaseDocuments: [],
};

function money(value: number): string {
  return `${faDigits(new Intl.NumberFormat("fa-IR").format(Math.round(value)))} ریال`;
}

// ───────────────────────── page ─────────────────────────

export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const firstName = user?.firstName || user?.username || "کاربر";

  const [data, setData] = useState<DashboardData | null>(null);
  const [pendingOrders, setPendingOrders] = useState<PendingOrderItem[]>([]);
  const [inactive, setInactive] = useState<InactiveCustomerItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [canSeeReports, setCanSeeReports] = useState(false);

  // ── Ctrl+K palette ──
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<SearchResults>(EMPTY_SEARCH);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [dash, orders, inactiveRows] = await Promise.all([
        apiJson<DashboardData>("/reports/dashboard"),
        apiJson<{ items: PendingOrderItem[] }>("/reports/pending-orders?olderThanDays=7"),
        apiJson<InactiveCustomerItem[]>("/reports/inactive-customers"),
      ]);
      setData(dash);
      setPendingOrders(orders.items.slice(0, 6));
      setInactive(inactiveRows.slice(0, 6));
      setCanSeeReports(true);
    } catch (e) {
      // بدون مجوز reports.view داشبورد ساده بماند (خطای مجوز نمایش داده نشود)
      const message = e instanceof Error ? e.message : String(e);
      if (!message.includes("PERMISSION") && !message.includes("FORBIDDEN")) {
        setError(message);
      }
      setCanSeeReports(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Ctrl+K opens the palette
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (paletteOpen) setTimeout(() => searchInputRef.current?.focus(), 30);
  }, [paletteOpen]);

  // debounced global search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = term.trim();
    if (q.length < 2) {
      setResults(EMPTY_SEARCH);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        setResults(await apiJson<SearchResults>(`/reports/search?q=${encodeURIComponent(q)}`));
      } catch {
        setResults(EMPTY_SEARCH);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [term]);

  const goTo = (href: string) => {
    setPaletteOpen(false);
    setTerm("");
    router.push(href);
  };

  const kpis = data
    ? [
        { label: "فروش تکمیل‌شده این ماه", value: money(data.sales.completedThisMonthTotal), hint: `${faDigits(data.sales.completedThisMonth)} سند`, href: "/sales" },
        { label: "سفارش‌های فروش باز", value: money(data.sales.openOrderTotal), hint: `${faDigits(data.sales.openOrders)} سند`, href: "/sales" },
        { label: "سفارش‌های خرید باز", value: money(data.purchase.openOrderTotal), hint: `${faDigits(data.purchase.openOrders)} سند`, href: "/purchases" },
        { label: "بارگیری امروز", value: faDigits(data.loadings.todayCount), hint: `${faDigits(data.loadings.pendingDriverRelease)} معطل تأیید مدیر`, href: "/loadings" },
        { label: "مشتریان غیرفعال", value: faDigits(data.customers.inactiveCount), hint: "بدون خرید در ۶۰ روز گذشته", href: "/parties" },
        { label: "موجودی منفی", value: faDigits(data.inventory.negativeStockVariants), hint: "واریانت با تراز داخلی منفی", href: "/inventory" },
      ]
    : [];

  return (
    <div className="space-y-6">
      {/* Welcome + palette trigger */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-slate-800">خوش آمدید، {firstName}</h2>
            <p className="mt-1 text-sm text-slate-500">
              نمای کلی فروش، خرید، بارگیری و موجودی — از منابع حقیقت عملیاتی.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-slate-50 px-3 text-sm text-slate-600 hover:bg-slate-100"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            جست‌وجوی سراسری
            <kbd className="rounded border border-slate-300 bg-white px-1.5 text-[10px] text-slate-500">Ctrl+K</kbd>
          </button>
        </div>
      </section>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

      {/* KPI cards */}
      {canSeeReports && (
        <section aria-label="شاخص‌های کلیدی">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-28 animate-pulse rounded-xl border border-slate-200 bg-slate-50" />
                ))
              : kpis.map((card) => {
                  const inner = (
                    <div className="h-full rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-primary-300">
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-medium text-slate-600">{card.label}</h3>
                        <span className="h-2 w-2 rounded-full bg-primary-500" aria-hidden="true" />
                      </div>
                      <p className="mt-3 text-xl font-bold text-slate-800">{card.value}</p>
                      <p className="mt-2 text-xs text-slate-400">{card.hint}</p>
                    </div>
                  );
                  return card.href ? (
                    <Link key={card.label} href={card.href}>
                      {inner}
                    </Link>
                  ) : (
                    <div key={card.label}>{inner}</div>
                  );
                })}
          </div>
        </section>
      )}

      {/* Pending orders + inactive customers */}
      {canSeeReports && (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">سفارش‌های معوق (بیش از ۷ روز)</h3>
              <Link href="/sales" className="text-xs text-sky-700 hover:underline">
                همه
              </Link>
            </div>
            {pendingOrders.length === 0 ? (
              <p className="mt-3 text-xs text-slate-400">سفارش معوقی نیست.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {pendingOrders.map((o) => (
                  <li key={o.documentId} className="flex items-center justify-between gap-2 rounded-md border border-slate-100 px-3 py-2">
                    <div>
                      <p className="text-xs font-medium text-slate-800" dir="ltr">
                        {o.documentNumber}
                      </p>
                      <p className="text-[11px] text-slate-500">
                        {o.customerName} — {o.salesperson}
                      </p>
                    </div>
                    <div className="text-left">
                      <p className="text-xs font-bold text-slate-700">{money(o.total)}</p>
                      <p className="text-[10px] text-amber-700">{faDigits(o.ageDays)} روز</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800">مشتریان غیرفعال (۶۰ روز)</h3>
              <Link href="/activities" className="text-xs text-sky-700 hover:underline">
                ثبت فعالیت پیگیری
              </Link>
            </div>
            {inactive.length === 0 ? (
              <p className="mt-3 text-xs text-slate-400">مشتری غیرفعالی نیست.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {inactive.map((c) => (
                  <li key={c.partyId} className="flex items-center justify-between gap-2 rounded-md border border-slate-100 px-3 py-2">
                    <Link href={`/parties/${c.partyId}`} className="text-xs font-medium text-slate-800 hover:underline">
                      {c.nameFa}
                    </Link>
                    <span className="text-[11px] text-slate-500">
                      {c.daysSinceLastPurchase === null
                        ? "بدون خرید"
                        : `${faDigits(c.daysSinceLastPurchase)} روز`}
                      {!c.hasMobile && <span className="ms-1 text-rose-600">بدون موبایل</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {/* Quick actions */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-800">دسترسی سریع</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          {[
            { label: "پیش‌فاکتور جدید", href: "/sales/new" },
            { label: "ثبت مشتری", href: "/parties/new" },
            { label: "درخواست قیمت", href: "/price-requests" },
          ].map((action) => (
            <Link
              key={action.label}
              href={action.href}
              className="inline-flex h-10 items-center gap-2 rounded-md border border-slate-300 bg-white px-4 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
                <path d="M12 5v14M5 12h14" />
              </svg>
              {action.label}
            </Link>
          ))}
        </div>
      </section>

      {/* Ctrl+K palette */}
      <Modal open={paletteOpen} title="جست‌وجوی سراسری" onClose={() => setPaletteOpen(false)} small>
        <div className="space-y-3">
          <input
            ref={searchInputRef}
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="طرف‌حساب، محصول، شماره سند… (حداقل ۲ حرف)"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-primary-500"
            aria-label="عبارت جست‌وجو"
          />
          {searching && <p className="text-xs text-slate-400">در حال جست‌وجو…</p>}
          <div className="max-h-72 space-y-3 overflow-auto">
            {results.parties.length > 0 && (
              <div>
                <p className="text-[11px] font-bold text-slate-500">طرف‌حساب‌ها</p>
                {results.parties.map((p) => (
                  <button key={p.id} type="button" onClick={() => goTo(`/parties/${p.id}`)} className="block w-full rounded px-2 py-1.5 text-right text-sm text-slate-700 hover:bg-slate-50">
                    {p.label}
                  </button>
                ))}
              </div>
            )}
            {results.variants.length > 0 && (
              <div>
                <p className="text-[11px] font-bold text-slate-500">محصولات</p>
                {results.variants.map((v) => (
                  <button key={v.id} type="button" onClick={() => goTo("/products")} className="block w-full rounded px-2 py-1.5 text-right text-sm text-slate-700 hover:bg-slate-50">
                    {v.label}
                  </button>
                ))}
              </div>
            )}
            {results.salesDocuments.length > 0 && (
              <div>
                <p className="text-[11px] font-bold text-slate-500">اسناد فروش</p>
                {results.salesDocuments.map((d) => (
                  <button key={d.id} type="button" onClick={() => goTo(`/sales/${d.id}`)} className="block w-full rounded px-2 py-1.5 text-right text-sm text-slate-700 hover:bg-slate-50">
                    <span dir="ltr" className="font-mono text-xs">{d.label}</span>
                    <span className="ms-2 text-[11px] text-slate-400">{money(d.total)}</span>
                  </button>
                ))}
              </div>
            )}
            {results.purchaseDocuments.length > 0 && (
              <div>
                <p className="text-[11px] font-bold text-slate-500">اسناد خرید</p>
                {results.purchaseDocuments.map((d) => (
                  <button key={d.id} type="button" onClick={() => goTo(`/purchases/${d.id}`)} className="block w-full rounded px-2 py-1.5 text-right text-sm text-slate-700 hover:bg-slate-50">
                    <span dir="ltr" className="font-mono text-xs">{d.label}</span>
                    <span className="ms-2 text-[11px] text-slate-400">{money(d.total)}</span>
                  </button>
                ))}
              </div>
            )}
            {term.trim().length >= 2 &&
              !searching &&
              results.parties.length === 0 &&
              results.variants.length === 0 &&
              results.salesDocuments.length === 0 &&
              results.purchaseDocuments.length === 0 && (
                <p className="text-xs text-slate-400">نتیجه‌ای یافت نشد.</p>
              )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
