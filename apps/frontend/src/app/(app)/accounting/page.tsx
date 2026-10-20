"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

interface Tile {
  href: string;
  title: string;
  description: string;
  permission: string;
}

const TILES: Tile[] = [
  {
    href: "/accounting/general-ledger",
    title: "دفتر کل",
    description: "گردش و مانده حساب‌ها با تفکیک اسناد و برگشت‌ها",
    permission: "accounting.report",
  },
  {
    href: "/accounting/trial-balance",
    title: "تراز آزمایشی",
    description: "تراز opening/گردش/closing سرفصل‌ها با وضعیت توازن",
    permission: "accounting.report",
  },
  {
    href: "/accounting/subsidiary-ledger",
    title: "دفتر معین",
    description: "مانده مشتریان و تامین‌کنندگان با جزئیات گردش هر حساب",
    permission: "accounting.report",
  },
  {
    href: "/accounting/operational-profit",
    title: "گزارش سود عملیاتی",
    description: "درآمد، بهای تمام‌شده و سود ناخالص بر پایه رویدادهای عملیاتی",
    permission: "accounting.report",
  },
  {
    href: "/accounting/inventory-valuation",
    title: "ارزش‌گذاری موجودی",
    description: "موجودی و ارزش هر کالا بر پایه اسناد بهای تمام‌شده",
    permission: "accounting.report",
  },
  {
    href: "/accounting/opening-balances",
    title: "افتتاحیه",
    description: "ثبت و صدای سند افتتاحیه",
    permission: "accounting.report",
  },
  {
    href: "/accounting/fiscal-years",
    title: "سال مالی",
    description: "سال‌ها و دوره‌های مالی، بستن و بازگشایی",
    permission: "accounting.fiscal.manage",
  },
  {
    href: "/accounting/events",
    title: "رویدادها و قواعد ثبت",
    description: "رویدادهای عملیاتی، خطاها و تلاش مجدد ثبت",
    permission: "accounting.posting.manage",
  },
];

export default function AccountingHubPage() {
  const { permissions } = useAuth();
  const visible = TILES.filter((t) => permissions.includes(t.permission));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-slate-900">حسابداری</h2>
        <p className="mt-1 text-sm text-slate-500">
          گزارش‌های مالی و چرخه سال مالی — همه اعداد با دقت اعشاری کامل و بدون خطای گرد کردن نمایش داده می‌شوند.
        </p>
      </div>
      {visible.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-500">
          دسترسی مشاهده گزارش‌های حسابداری را ندارید. با مدیر سیستم تماس بگیرید.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((tile) => (
            <Link
              key={tile.href}
              href={tile.href}
              className="group rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-300 hover:shadow-md"
            >
              <div className="text-sm font-semibold text-slate-900 group-hover:text-teal-700">
                {tile.title}
              </div>
              <div className="mt-2 text-xs leading-5 text-slate-500">{tile.description}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
