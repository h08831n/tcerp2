"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { faDigits, faMoney, jalaliDateTime, thousandSeparate } from "@/lib/format";
import {
  fetchScore,
  partyErrorMessage,
  recomputeScore,
  scoreLevelLabel,
  type PartyDetail,
  type ScoreResponse,
} from "@/lib/party";
import { ScoreBadge } from "@/components/parties/badges";

interface ScoreTabProps {
  party: PartyDetail;
  onChanged: (party: PartyDetail) => void;
}

const METRIC_LABELS: Record<string, string> = {
  totalOrders: "تعداد سفارش‌ها",
  totalSales: "مجموع فروش",
  totalPurchases: "مجموع خرید",
  onTimePaymentRatio: "نسبت پرداخت به‌موقع",
  overdueDebt: "بدهی سررسید گذشته",
  activeYears: "سال‌های همکاری",
  complaintCount: "تعداد شکایات",
  returnCount: "تعداد مرجوعی",
};

function metricLabel(key: string): string {
  return METRIC_LABELS[key] ?? key;
}

function metricValue(key: string, value: number): string {
  if (/ratio|Ratio|rate|Score/.test(key)) {
    return `${faDigits(Math.round(value * 100))}٪`;
  }
  if (/total|Total|Sales|Purchases|Debt|Amount|balance/i.test(key)) {
    return faMoney(value);
  }
  return faDigits(thousandSeparate(value));
}

export function ScoreTab({ party, onChanged }: ScoreTabProps) {
  const { user, permissions } = useAuth();
  const canRecompute =
    user?.role === "MANAGER" ||
    permissions.some((permission) => /manager|score/i.test(permission));

  const [data, setData] = useState<ScoreResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchScore(party.id)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(partyErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [party.id, party.version]);

  async function handleRecompute() {
    if (recomputing) return;
    setRecomputing(true);
    setError(null);
    try {
      const result = await recomputeScore(party.id);
      setData(result);
      onChanged(party); // trigger parent refresh of score badge
    } catch (err) {
      setError(partyErrorMessage(err));
    } finally {
      setRecomputing(false);
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 text-sm text-slate-400 shadow-sm">
        در حال بارگذاری امتیاز…
      </div>
    );
  }

  if (error && !data) {
    return (
      <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 shadow-sm">
        {error}
      </div>
    );
  }

  const metricEntries = Object.entries(data?.metrics ?? {});

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-bold text-slate-800">امتیاز فعلی</h3>
            {data && <ScoreBadge score={data.score} level={data.level} />}
            {data && (
              <span className="text-xs text-slate-500">
                سطح: {scoreLevelLabel(data.level)}
              </span>
            )}
          </div>
          {canRecompute && (
            <Button size="sm" variant="secondary" onClick={handleRecompute} disabled={recomputing}>
              {recomputing ? "در حال محاسبه…" : "محاسبه مجدد امتیاز"}
            </Button>
          )}
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {metricEntries.length > 0 ? (
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {metricEntries.map(([key, value]) => (
              <div key={key} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <dt className="text-[11px] text-slate-400">{metricLabel(key)}</dt>
                <dd className="mt-1 text-sm font-bold text-slate-800">
                  {metricValue(key, value)}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="mt-3 text-xs text-slate-400">معیاری ثبت نشده است.</p>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <h3 className="border-b border-slate-200 bg-slate-50 px-4 py-2.5 text-sm font-bold text-slate-700">
          تاریخچه امتیاز
        </h3>
        {!data || data.history.length === 0 ? (
          <p className="py-6 text-center text-sm text-slate-400">تاریخچه‌ای ثبت نشده است.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-start font-semibold">امتیاز</th>
                <th scope="col" className="px-4 py-2 text-start font-semibold">سطح</th>
                <th scope="col" className="px-4 py-2 text-start font-semibold">معیارها</th>
                <th scope="col" className="px-4 py-2 text-start font-semibold">زمان محاسبه</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.history.map((entry, index) => (
                <tr key={index}>
                  <td className="px-4 py-2 font-bold text-slate-800">{faDigits(entry.score)}</td>
                  <td className="px-4 py-2">{scoreLevelLabel(entry.level)}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">
                    {Object.entries(entry.metrics ?? {})
                      .map(([key, value]) => `${metricLabel(key)}: ${metricValue(key, value)}`)
                      .join("، ") || "—"}
                  </td>
                  <td className="px-4 py-2 tabular-nums text-slate-500">
                    {jalaliDateTime(entry.computedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
