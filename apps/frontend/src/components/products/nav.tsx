"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const SECTIONS = [
  { href: "/products", label: "محصولات" },
  { href: "/products/categories", label: "گروه‌ها" },
  { href: "/products/brands", label: "برندها" },
  { href: "/products/uom", label: "واحدها" },
  { href: "/products/attributes", label: "ویژگی‌ها" },
  { href: "/products/supplier-mappings", label: "تامین‌کنندگان" },
] as const;

/** RTL section navigation shared by all /products/* screens. */
export function ProductsNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav
      aria-label="بخش‌های محصولات"
      className="flex flex-wrap gap-1 rounded-xl border border-slate-200 bg-white p-1.5 shadow-sm"
    >
      {SECTIONS.map((section) => {
        const active =
          section.href === "/products"
            ? pathname === "/products" || /^\/products\/[^/]+$/.test(pathname) || pathname === "/products/new"
            : pathname === section.href || pathname.startsWith(`${section.href}/`);
        return (
          <Link
            key={section.href}
            href={section.href}
            aria-current={active ? "page" : undefined}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
              active
                ? "bg-primary-600 text-white"
                : "text-slate-600 hover:bg-slate-100 hover:text-slate-800"
            }`}
          >
            {section.label}
          </Link>
        );
      })}
    </nav>
  );
}
