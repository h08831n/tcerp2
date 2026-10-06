"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/lib/auth-context";

interface NavItem {
  label: string;
  href: string;
  icon: ReactNode;
}

function NavIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-[18px] w-[18px] shrink-0"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

const NAV_ITEMS: NavItem[] = [
  { label: "داشبورد", href: "/dashboard", icon: <NavIcon d="M3 12h4l2-7 4 14 2-7h6" /> },
  { label: "مشتریان و تامین‌کنندگان", href: "/parties", icon: <NavIcon d="M17 21v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM21 21v-2a4 4 0 00-3-3.87M15 3.13a4 4 0 010 7.75" /> },
  { label: "محصولات", href: "/products", icon: <NavIcon d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16zM3.3 7L12 12l8.7-5M12 22V12" /> },
  { label: "فروش", href: "/sales", icon: <NavIcon d="M12 8c-1.66 0-3 .9-3 2s1.34 2 3 2 3 .9 3 2-1.34 2-3 2m0-8V7m0 10v1m9-6a9 9 0 11-18 0 9 9 0 0118 0z" /> },
  { label: "خرید", href: "/purchases", icon: <NavIcon d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4H6zM3 6h18M16 10a4 4 0 01-8 0" /> },
  { label: "درخواست قیمت", href: "/price-requests", icon: <NavIcon d="M9 14l6-6m-5.5.5l1 1M14 13l1 1M3 3h18v18H3zM8 8h.01M16 16h.01" /> },
  { label: "قیمت روز", href: "#", icon: <NavIcon d="M3 3v18h18M8 17V9m4 8V5m4 12v-6" /> },
  { label: "بارگیری", href: "#", icon: <NavIcon d="M1 3h15v13H1zM16 8h4l3 3v5h-7V8zM5.5 21a2.5 2.5 0 100-5 2.5 2.5 0 000 5zm13 0a2.5 2.5 0 100-5 2.5 2.5 0 000 5z" /> },
  { label: "انبار", href: "#", icon: <NavIcon d="M4 21V8l8-5 8 5v13M9 21v-6h6v6M9 11h.01M15 11h.01" /> },
  { label: "حسابداری", href: "#", icon: <NavIcon d="M4 4h16v16H4zM8 8h8M8 12h8M8 16h5" /> },
  { label: "فاکتور مالیاتی", href: "#", icon: <NavIcon d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zM14 2v6h6M9 13h6M9 17h4" /> },
  { label: "مؤدیان", href: "#", icon: <NavIcon d="M9 12l2 2 4-4M12 22a10 10 0 100-20 10 10 0 000 20z" /> },
  { label: "فعالیت‌ها", href: "#", icon: <NavIcon d="M22 12h-4l-3 9L9 3l-3 9H2" /> },
  { label: "گزارش‌ها", href: "#", icon: <NavIcon d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /> },
  { label: "تنظیمات", href: "#", icon: <NavIcon d="M12 15a3 3 0 100-6 3 3 0 000 6zm7.4-3a7.4 7.4 0 00-.1-1.2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 00-2-1.2L14.5 2h-5L9 4.5a7.4 7.4 0 00-2 1.2l-2.5-1-2 3.5L4.6 9.8a7.4 7.4 0 000 2.4L2.5 13.8l2 3.5 2.5-1a7.4 7.4 0 002 1.2L9.5 20h5l.4-2.5a7.4 7.4 0 002-1.2l2.5 1 2-3.5-2.1-1.6c.1-.4.1-.8.1-1.2z" /> },
];

const TITLES: Record<string, string> = {
  "/dashboard": "داشبورد",
  "/parties": "مشتریان و تامین‌کنندگان",
  "/parties/new": "ثبت مشتری جدید",
  "/products": "محصولات",
  "/products/new": "محصول جدید",
  "/products/categories": "گروه‌های کالا",
  "/products/brands": "برندها",
  "/products/uom": "واحدهای اندازه‌گیری",
  "/products/attributes": "ویژگی‌ها",
  "/products/supplier-mappings": "نگاشت تامین‌کنندگان",
  "/sales": "فروش",
  "/sales/new": "پیش‌فاکتور جدید",
  "/sales/follow-up": "پیگیری پیش‌فاکتورها",
  "/purchases": "خرید",
  "/purchases/new": "سند خرید جدید",
  "/price-requests": "درخواست قیمت",
  "/allocations": "تخصیص بار",
  "/crm/leads": "سرنخ‌ها",
  "/crm/opportunities": "فرصت‌های فروش",
};

/** Blocks rendering until /auth/me resolves; redirects to /login on failure. */
function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100">
        <svg
          className="h-8 w-8 animate-spin text-primary-600"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>
      </div>
    );
  }

  return <>{children}</>;
}

function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const pageTitle = useMemo(() => {
    if (pathname && TITLES[pathname]) return TITLES[pathname];
    return "سامانه مدیریت آهن و فولاد";
  }, [pathname]);

  const fullName = user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.username
    : "";
  const role =
    user?.role && typeof user.role === "string" ? user.role : "کاربر";

  async function handleLogout() {
    if (loggingOut) return;
    setLoggingOut(true);
    setUserMenuOpen(false);
    await logout();
    router.replace("/login");
  }

  return (
    <div className="flex min-h-screen">
        {/* Sidebar (right side in RTL) */}
        <aside
          className={`sticky top-0 flex h-screen flex-col border-l border-slate-200 bg-slate-900 text-slate-300 transition-all duration-200 ${
            sidebarOpen ? "w-64" : "w-16"
          }`}
        >
          <div className="flex h-16 items-center gap-3 border-b border-slate-700/60 px-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-600">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5 text-white"
                aria-hidden="true"
              >
                <path d="M3 20h18M5 20V9l7-5 7 5v11M9 20v-6h6v6" />
              </svg>
            </div>
            {sidebarOpen && (
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-white">TCERP</p>
                <p className="truncate text-[11px] text-slate-400">
                  سامانه مدیریت آهن و فولاد
                </p>
              </div>
            )}
          </div>

          <nav className="flex-1 overflow-y-auto px-2 py-3">
            <ul className="space-y-0.5">
              {NAV_ITEMS.map((item) => {
                const isActive =
                  item.href !== "#" &&
                  (pathname === item.href || pathname.startsWith(`${item.href}/`));
                return (
                  <li key={item.label}>
                    {item.href === "#" ? (
                      <span
                        title="به‌زودی"
                        className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-500 ${
                          sidebarOpen ? "" : "justify-center px-0"
                        }`}
                      >
                        {item.icon}
                        {sidebarOpen && <span className="truncate">{item.label}</span>}
                      </span>
                    ) : (
                      <Link
                        href={item.href}
                        className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors ${
                          isActive
                            ? "bg-primary-600 font-medium text-white"
                            : "hover:bg-slate-800 hover:text-white"
                        } ${sidebarOpen ? "" : "justify-center px-0"}`}
                        title={item.label}
                      >
                        {item.icon}
                        {sidebarOpen && <span className="truncate">{item.label}</span>}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="border-t border-slate-700/60 p-2">
            <button
              type="button"
              onClick={() => setSidebarOpen((open) => !open)}
              className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm text-slate-400 hover:bg-slate-800 hover:text-white ${
                sidebarOpen ? "" : "justify-center px-0"
              }`}
              aria-label={sidebarOpen ? "بستن منو" : "باز کردن منو"}
              title={sidebarOpen ? "بستن منو" : "باز کردن منو"}
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={`h-4 w-4 transition-transform ${
                  sidebarOpen ? "" : "rotate-180"
                }`}
                aria-hidden="true"
              >
                <path d="M11 19l-7-7 7-7M19 19l-7-7 7-7" />
              </svg>
              {sidebarOpen && <span>بستن منو</span>}
            </button>
          </div>
        </aside>

        {/* Main area */}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-20 flex h-16 items-center gap-4 border-b border-slate-200 bg-white px-6">
            <h1 className="shrink-0 text-base font-bold text-slate-800">
              {pageTitle}
            </h1>

            {/* Search placeholder (Ctrl+K reserved) */}
            <div className="mx-auto hidden w-full max-w-sm md:block">
              <div className="flex h-9 items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 text-slate-400">
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
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.35-4.35" />
                </svg>
                <span className="text-xs">جستجو (Ctrl+K)</span>
              </div>
            </div>

            <div className="relative ms-auto flex items-center gap-3">
              <button
                type="button"
                className="relative flex h-9 w-9 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                aria-label="اعلان‌ها"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-5 w-5"
                  aria-hidden="true"
                >
                  <path d="M18 8a6 6 0 00-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0" />
                </svg>
                <span className="absolute -top-0.5 -left-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold leading-none text-white">
                  ۰
                </span>
              </button>

              {user && (
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setUserMenuOpen((open) => !open)}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-slate-100"
                    aria-haspopup="menu"
                    aria-expanded={userMenuOpen}
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-100 text-sm font-bold text-primary-700">
                      {fullName.slice(0, 1) || "؟"}
                    </span>
                    <span className="hidden text-right sm:block">
                      <span className="block max-w-40 truncate text-xs font-semibold text-slate-700">
                        {fullName}
                      </span>
                      <span className="block text-[11px] text-slate-500">{role}</span>
                    </span>
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 text-slate-400"
                      aria-hidden="true"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>

                  {userMenuOpen && (
                    <>
                      <button
                        type="button"
                        className="fixed inset-0 z-30 cursor-default"
                        aria-hidden="true"
                        tabIndex={-1}
                        onClick={() => setUserMenuOpen(false)}
                      />
                      <div
                        role="menu"
                        className="absolute end-0 z-40 mt-2 w-44 rounded-md border border-slate-200 bg-white py-1 shadow-lg"
                      >
                        <div className="border-b border-slate-100 px-4 py-2">
                          <p className="truncate text-xs font-semibold text-slate-700">
                            {fullName}
                          </p>
                          <p className="text-[11px] text-slate-500" dir="ltr">
                            {user.username}
                          </p>
                        </div>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={handleLogout}
                          disabled={loggingOut}
                          className="flex w-full items-center gap-2 px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
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
                            <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9" />
                          </svg>
                          خروج
                        </button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </header>

          <main className="flex-1 p-6">{children}</main>
        </div>
      </div>
  );
}

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <AuthProvider>
      <AuthGate>
        <AppShell>{children}</AppShell>
      </AuthGate>
    </AuthProvider>
  );
}
