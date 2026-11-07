"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  portalApi,
  portalLogout,
  portalFileDownloadUrl,
  type PortalProfile,
  type PortalOrder,
  type PortalLoading,
  type PortalDebt,
  type PortalFile,
  PortalApiError,
} from "@/lib/portal";

const ORDER_STATUS_FA: Record<string, string> = {
  QUOTATION: "استعلام",
  SENT: "ارسال‌شده",
  CUSTOMER_CONFIRMED: "تأیید مشتری",
  SALES_ORDER: "سفارش فروش",
  PARTIALLY_LOADED: "بارگیری جزئی",
  COMPLETED: "تکمیل‌شده",
};

const LOADING_STATUS_FA: Record<string, string> = {
  DRAFT: "پیش‌نویس",
  CONFIRMED: "تأییدشده",
  REVERSED: "برگشتی",
  CANCELLED: "لغوشده",
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("fa-IR");
}

function formatMoney(value: string | number, currency: string): string {
  const num = typeof value === 'string' ? Number(value) : value;
  const suffix = currency === 'IRR' ? 'ریال' : currency ? currency : '';
  return `${num.toLocaleString('fa-IR')}${suffix ? ` ${suffix}` : ''}`;
}

export default function PortalDashboardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<PortalProfile | null>(null);
  const [orders, setOrders] = useState<PortalOrder[]>([]);
  const [loadings, setLoadings] = useState<PortalLoading[]>([]);
  const [debt, setDebt] = useState<PortalDebt | null>(null);
  const [files, setFiles] = useState<PortalFile[]>([]);
  const [tab, setTab] = useState<"orders" | "loadings" | "files">("orders");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const handle401 = useCallback(
    (e: unknown) => {
      if (e instanceof PortalApiError && e.status === 401) {
        router.push("/portal/login");
        return true;
      }
      return false;
    },
    [router],
  );

  const refresh = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const [p, o, l, d, f] = await Promise.all([
        portalApi.profile(),
        portalApi.orders(),
        portalApi.loadings(),
        portalApi.debt(),
        portalApi.files(),
      ]);
      setProfile(p);
      setOrders(o.items);
      setLoadings(l.items);
      setDebt(d);
      setFiles(f.items);
    } catch (e) {
      if (!handle401(e)) setError((e as PortalApiError).message);
    } finally {
      setLoading(false);
    }
  }, [handle401]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleLogout() {
    try {
      await portalLogout();
    } catch (e) {
      if (handle401(e)) return;
    }
    router.push("/portal/login");
  }

  return (
    <main className="min-h-screen bg-slate-100">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between p-4">
          <div>
            <h1 className="text-lg font-bold text-slate-900">پورتال مشتریان</h1>
            {profile && (
              <p className="text-xs text-slate-500">
                {profile.partyName} — {profile.companyName}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {debt && debt.computed && (
              <span
                className={`rounded-full px-3 py-1 text-xs font-medium ${
                  debt.direction === "DEBT" ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"
                }`}
              >
                {debt.direction === "DEBT" ? "مانده بدهی:" : "اعتبار:"}{" "}
                {formatMoney(debt.balance.replace("-", ""), debt.currency ?? "")}
              </span>
            )}
            {debt && !debt.computed && (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">
                مانده محاسبه نشده
              </span>
            )}
            <Button variant="secondary" size="sm" onClick={handleLogout}>
              خروج
            </Button>
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-5xl p-4">
        {error && (
          <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700" role="alert">
            {error}
          </div>
        )}
        {loading ? (
          <p className="p-8 text-center text-sm text-slate-500">در حال بارگذاری…</p>
        ) : (
          <>
            <nav className="mb-4 flex gap-2">
              {(
                [
                  ["orders", `سفارش‌ها (${orders.length})`],
                  ["loadings", `بارگیری‌ها (${loadings.length})`],
                  ["files", `فایل‌ها (${files.length})`],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className={`rounded-lg px-4 py-2 text-sm font-medium ${
                    tab === key ? "bg-slate-900 text-white" : "bg-white text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {label}
                </button>
              ))}
            </nav>

            {tab === "orders" && (
              <section className="space-y-3">
                {orders.length === 0 && <p className="rounded-lg bg-white p-6 text-sm text-slate-500">سفارشی ثبت نشده است.</p>}
                {orders.map((o) => (
                  <article key={o.id} className="rounded-lg bg-white p-4 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-medium text-slate-900">{o.documentNumber}</span>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">
                        {ORDER_STATUS_FA[o.status] ?? o.status}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{formatDate(o.documentDate)}</p>
                    <table className="mt-3 w-full text-right text-xs">
                      <thead className="text-slate-400">
                        <tr>
                          <th className="p-1">کالا</th>
                          <th className="p-1">مقدار</th>
                          <th className="p-1">واحد</th>
                          <th className="p-1">قیمت واحد</th>
                        </tr>
                      </thead>
                      <tbody>
                        {o.lines.map((l, i) => (
                          <tr key={i} className="border-t">
                            <td className="p-1">{l.productName}</td>
                            <td className="p-1">{l.orderedQuantity.toLocaleString("fa-IR")}</td>
                            <td className="p-1">{l.uom}</td>
                            <td className="p-1">{formatMoney(l.unitPrice, o.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="mt-2 text-left text-sm font-bold">{formatMoney(o.total, o.currency)}</p>
                  </article>
                ))}
              </section>
            )}

            {tab === "loadings" && (
              <section className="space-y-3">
                {loadings.length === 0 && <p className="rounded-lg bg-white p-6 text-sm text-slate-500">بارگیری‌ای ثبت نشده است.</p>}
                {loadings.map((l) => (
                  <article key={l.id} className="rounded-lg bg-white p-4 shadow-sm">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-sm text-slate-700">{formatDate(l.loadingDate)}</span>
                      <span className="rounded-full bg-slate-100 px-3 py-1 text-xs">
                        {LOADING_STATUS_FA[l.status] ?? l.status}
                      </span>
                    </div>
                    {l.route && <p className="text-xs text-slate-500">مسیر: {l.route}</p>}
                    <ul className="mt-2 space-y-1 text-xs">
                      {l.lines.map((line, i) => (
                        <li key={i} className="flex justify-between border-b pb-1">
                          <span>{line.productName}</span>
                          <span>
                            {line.actualQuantity.toLocaleString("fa-IR")} {line.uom}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ))}
              </section>
            )}

            {tab === "files" && (
              <section className="space-y-2">
                {files.length === 0 && <p className="rounded-lg bg-white p-6 text-sm text-slate-500">فایلی برای اسناد شما ثبت نشده است.</p>}
                {files.map((f) => (
                  <a
                    key={f.id}
                    href={portalFileDownloadUrl(f.id)}
                    className="flex items-center justify-between rounded-lg bg-white p-4 shadow-sm hover:bg-slate-50"
                  >
                    <span className="text-sm font-medium text-slate-900">{f.filename}</span>
                    <span className="text-xs text-slate-500">
                      {(f.size / 1024).toFixed(1)} کیلوبایت — {formatDate(f.createdAt)}
                    </span>
                  </a>
                ))}
              </section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
