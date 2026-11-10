"use client";

/**
 * CORE-003 — مرکز جامع تنظیمات (settings center).
 *
 * Sidebar دسته‌بندی‌ها + جستجو + ویرایش typed + Restore به پیش‌فرض.
 * The catalog comes from GET /settings/catalog (registry + current values);
 * every entry has a REAL backend consumer (shown under each field).
 * Secrets are masked server-side; none exist in this registry today.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  fetchSettingsCatalog,
  restoreSettingDefault,
  saveSetting,
  type SettingCatalogEntry,
} from "@/lib/admin";
import Link from "next/link";
import { useAuth } from "@/lib/auth-context";
import { jalaliDateTime } from "@/lib/format";

const CATEGORY_LABELS: Record<string, string> = {
  general: "عمومی",
  crm: "CRM",
  sales: "فروش",
  purchase: "خرید",
  inventory: "انبار",
  accounting: "حسابداری",
  treasury: "خزانه و بانک",
  files: "فایل‌ها و Storage",
  integrations: "یکپارچه‌سازی‌ها",
};

export default function SettingsCenterPage() {
  const { permissions } = useAuth();
  const canEdit = permissions.includes("settings.edit");

  const [entries, setEntries] = useState<SettingCatalogEntry[] | null>(null);
  // CORE-003 §2 — real reference-data management pages (no "به‌زودی" links).
  const referenceLinks = [
    { label: "دسته‌بندی کالا", href: "/products/categories", perm: "products.view" },
    { label: "برندها", href: "/products/brands", perm: "products.view" },
    { label: "واحدهای اندازه‌گیری", href: "/products/uom", perm: "products.view" },
    { label: "ویژگی‌های محصول", href: "/products/attributes", perm: "products.view" },
    { label: "نگاشت تامین‌کنندگان", href: "/products/supplier-mappings", perm: "products.view" },
    { label: "دلایل باخت", href: "/settings/lost-reasons", perm: "crm.view" },
    { label: "شرایط پرداخت", href: "/settings/payment-terms", perm: "crm.view" },
    { label: "انواع فعالیت", href: "/activities", perm: "activities.view" },
  ];
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("");
  const [search, setSearch] = useState("");
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    fetchSettingsCatalog()
      .then((items) => {
        if (!cancelled) {
          setEntries(items);
          setDrafts(
            Object.fromEntries(items.map((e) => [e.key, e.value ?? ""])),
          );
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "خطا در بارگذاری تنظیمات");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load]);

  const categories = useMemo(() => {
    const set = new Set((entries ?? []).map((e) => e.category));
    return Array.from(set);
  }, [entries]);

  const visible = useMemo(() => {
    const list = entries ?? [];
    const q = search.trim().toLowerCase();
    return list.filter((e) => {
      if (category && e.category !== category) return false;
      if (!q) return true;
      return (
        e.labelFa.toLowerCase().includes(q) ||
        e.key.toLowerCase().includes(q) ||
        (e.descriptionFa ?? "").toLowerCase().includes(q)
      );
    });
  }, [entries, category, search]);

  async function handleSave(e: SettingCatalogEntry) {
    setSavingKey(e.key);
    setNotice(null);
    try {
      await saveSetting(e.key, drafts[e.key]);
      setNotice(`«${e.labelFa}» ذخیره شد و از این لحظه در ماژول مربوطه اعمال می‌شود.`);
      // Refresh the entry (updatedAt/isOverridden).
      const fresh = await fetchSettingsCatalog();
      setEntries(fresh);
      setDrafts((d) => ({
        ...d,
        ...Object.fromEntries(fresh.map((x) => [x.key, x.value ?? ""])),
      }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "خطا در ذخیره");
    } finally {
      setSavingKey(null);
    }
  }

  async function handleRestore(e: SettingCatalogEntry) {
    setSavingKey(e.key);
    setNotice(null);
    try {
      await restoreSettingDefault(e.key);
      setNotice(`«${e.labelFa}» به مقدار پیش‌فرض برگشت.`);
      const fresh = await fetchSettingsCatalog();
      setEntries(fresh);
      setDrafts((d) => ({
        ...d,
        ...Object.fromEntries(fresh.map((x) => [x.key, x.value ?? ""])),
      }));
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "خطا در بازگردانی");
    } finally {
      setSavingKey(null);
    }
  }

  function renderEditor(entry: SettingCatalogEntry) {
    const disabled = !canEdit || savingKey === entry.key;
    const value = drafts[entry.key];
    if (entry.type === "boolean") {
      return (
        <select
          aria-label={`مقدار ${entry.labelFa}`}
          disabled={disabled}
          value={String(value === true || value === "true")}
          onChange={(ev) =>
            setDrafts((d) => ({ ...d, [entry.key]: ev.target.value === "true" }))
          }
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          <option value="true">فعال</option>
          <option value="false">غیرفعال</option>
        </select>
      );
    }
    if (entry.type === "select" && entry.options) {
      const opts = (drafts[entry.key] as string[] | undefined) ?? entry.options;
      const isList = Array.isArray(opts);
      if (isList) {
        return (
          <Input
            aria-label={`مقدار ${entry.labelFa}`}
            disabled={disabled}
            value={Array.isArray(value) ? (value as string[]).join(", ") : String(value ?? "")}
            onChange={(ev) => setDrafts((d) => ({ ...d, [entry.key]: ev.target.value }))}
          />
        );
      }
      return (
        <select
          aria-label={`مقدار ${entry.labelFa}`}
          disabled={disabled}
          value={String(value ?? "")}
          onChange={(ev) => setDrafts((d) => ({ ...d, [entry.key]: ev.target.value }))}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
        >
          {entry.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    }
    return (
      <Input
        aria-label={`مقدار ${entry.labelFa}`}
        dir="ltr"
        type={entry.type === "number" ? "number" : "text"}
        disabled={disabled}
        value={String(value ?? "")}
        onChange={(ev) =>
          setDrafts((d) => ({
            ...d,
            [entry.key]: entry.type === "number" ? Number(ev.target.value) : ev.target.value,
          }))
        }
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      {/* Sidebar */}
      <aside className="h-fit rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <p className="mb-2 px-1 text-xs font-bold text-slate-500">دسته‌بندی‌ها</p>
        <ul className="space-y-0.5">
          <li>
            <button
              type="button"
              onClick={() => setCategory("")}
              className={`w-full rounded-md px-3 py-1.5 text-right text-sm ${
                category === "" ? "bg-primary-600 font-medium text-white" : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              همه
            </button>
          </li>
          {categories.map((c) => (
            <li key={c}>
              <button
                type="button"
                onClick={() => setCategory(c)}
                className={`w-full rounded-md px-3 py-1.5 text-right text-sm ${
                  category === c ? "bg-primary-600 font-medium text-white" : "text-slate-600 hover:bg-slate-100"
                }`}
              >
                {CATEGORY_LABELS[c] ?? c}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="w-full sm:w-72">
            <label htmlFor="sc-search" className="mb-1 block text-xs font-medium text-slate-600">
              جستجوی تنظیمات
            </label>
            <Input
              id="sc-search"
              inputSize="sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="عنوان یا کلید…"
            />
          </div>
          {!canEdit && (
            <p className="rounded-md bg-amber-50 px-3 py-1.5 text-[11px] text-amber-700">
              شما مجوز ویرایش تنظیمات ندارید — فقط مشاهده.
            </p>
          )}
        </div>

        {notice && (
          <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        )}
        {error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* CORE-003 §2 — داده‌های مرجع: لینک به صفحات CRUD واقعی موجود */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-2 text-xs font-bold text-slate-600">داده‌های مرجع (صفحات مدیریت)</p>
          <div className="flex flex-wrap gap-2">
            {referenceLinks
              .filter((l) => permissions.includes(l.perm))
              .map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-700 transition-colors hover:border-primary-300 hover:bg-primary-50"
                >
                  {l.label} ↗
                </Link>
              ))}
          </div>
        </div>

        {entries === null ? (
          <p className="text-sm text-slate-400">در حال بارگذاری…</p>
        ) : visible.length === 0 ? (
          <p className="rounded-md border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
            تنظیمی مطابق جستجو یافت نشد.
          </p>
        ) : (
          <div className="space-y-3">
            {visible.map((entry) => (
              <div key={entry.key} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold text-slate-800">{entry.labelFa}</p>
                    <p className="mt-0.5 text-[11px] text-slate-500">{entry.descriptionFa}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    {entry.isOverridden ? (
                      <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] text-indigo-700">
                        سفارشی‌شده
                      </span>
                    ) : (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">
                        پیش‌فرض
                      </span>
                    )}
                  </div>
                </div>
                <div className="mt-2 max-w-xl">{renderEditor(entry)}</div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] text-slate-400" dir="ltr">
                    {entry.key} — consumer: {entry.consumer}
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">
                      {entry.updatedAt ? `آخرین تغییر: ${jalaliDateTime(entry.updatedAt)}` : "بدون تغییر"}
                    </span>
                    {canEdit && entry.isOverridden && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={savingKey === entry.key}
                        onClick={() => void handleRestore(entry)}
                      >
                        بازگردانی پیش‌فرض
                      </Button>
                    )}
                    {canEdit && (
                      <Button
                        size="sm"
                        disabled={savingKey === entry.key || !entry.isOverridden}
                        onClick={() => void handleSave(entry)}
                      >
                        {savingKey === entry.key ? "…" : "ذخیره"}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
