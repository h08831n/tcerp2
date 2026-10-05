"use client";

import { useAuth } from "@/lib/auth-context";

const KPI_CARDS = [
  { label: "فروش امروز", hint: "مجموع مبلغ پیش‌فاکتورهای امروز" },
  { label: "سفارش‌های باز", hint: "سفارش‌های در انتظار تأیید یا ارسال" },
  { label: "بارگیری‌های امروز", hint: "بارگیری‌های برنامه‌ریزی‌شده امروز" },
  { label: "مطالبات وصول‌نشده", hint: "مطالبات سررسید گذشته" },
];

const QUICK_ACTIONS = [
  { label: "پیش‌فاکتور جدید" },
  { label: "ثبت مشتری" },
  { label: "درخواست قیمت" },
];

export default function DashboardPage() {
  const { user } = useAuth();
  const firstName = user?.firstName || user?.username || "کاربر";

  return (
    <div className="space-y-6">
      {/* Welcome card */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold text-slate-800">
          خوش آمدید، {firstName}
        </h2>
        <p className="mt-1 text-sm text-slate-500">
          اینجا نمای کلی فعالیت‌های امروز را می‌بینید. برای شروع، از دسترسی‌های
          سریع استفاده کنید.
        </p>
      </section>

      {/* KPI cards */}
      <section aria-label="شاخص‌های کلیدی">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {KPI_CARDS.map((card) => (
            <div
              key={card.label}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-medium text-slate-600">
                  {card.label}
                </h3>
                <span
                  className="h-2 w-2 rounded-full bg-primary-500"
                  aria-hidden="true"
                />
              </div>
              <p className="mt-3 text-2xl font-bold text-slate-400" dir="ltr">
                —
              </p>
              <p className="mt-2 text-xs text-slate-400">{card.hint}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Quick actions */}
      <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-sm font-bold text-slate-800">دسترسی سریع</h3>
        <div className="mt-4 flex flex-wrap gap-3">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              disabled
              title="به‌زودی"
              className="inline-flex h-10 items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-4 text-sm font-medium text-slate-500"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4"
                aria-hidden="true"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              {action.label}
            </button>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-400">
          این بخش در فازهای بعدی تکمیل می‌شود.
        </p>
      </section>
    </div>
  );
}
