"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ProductsNav } from "@/components/products/nav";
import { StatusBadge } from "@/components/parties/badges";
import { GeneralTab } from "@/components/products/general-tab";
import { VariantsTab } from "@/components/products/variants-tab";
import { AttributesTab } from "@/components/products/attributes-tab";
import { UomTab } from "@/components/products/uom-tab";
import { SuppliersTab } from "@/components/products/suppliers-tab";
import { FilesTab } from "@/components/products/files-tab";
import { HistoryTab } from "@/components/products/history-tab";
import { faDigits, jalali } from "@/lib/format";
import {
  PRODUCT_TYPE_LABELS,
  archiveTemplate,
  fetchTemplate,
  productErrorMessage,
  type TemplateDetail,
} from "@/lib/product";

const TABS = [
  { key: "general", label: "عمومی" },
  { key: "variants", label: "محصولات (Variants)" },
  { key: "attributes", label: "ویژگی‌ها" },
  { key: "uom", label: "واحدها" },
  { key: "suppliers", label: "تامین‌کنندگان" },
  { key: "files", label: "فایل‌ها" },
  { key: "history", label: "تاریخچه" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export default function ProductDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [template, setTemplate] = useState<TemplateDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("general");
  const [archiving, setArchiving] = useState(false);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTemplate(id);
      setTemplate(result);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const onChanged = useCallback((updated: TemplateDetail) => {
    setTemplate(updated);
  }, []);

  async function handleArchive() {
    if (!template || archiving) return;
    setArchiving(true);
    setActionError(null);
    try {
      await archiveTemplate(template.id);
      await load();
    } catch (err) {
      setActionError(productErrorMessage(err));
    } finally {
      setArchiving(false);
    }
  }

  // Tab keyboard navigation: in RTL, ArrowLeft = next tab, ArrowRight = previous.
  function handleTablistKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const currentIndex = TABS.findIndex((tab) => tab.key === activeTab);
    let nextIndex: number | null = null;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex + 1) % TABS.length;
    else if (event.key === "ArrowRight")
      nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = TABS.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    setActiveTab(TABS[nextIndex].key);
    tabRefs.current[nextIndex]?.focus();
  }

  if (loading && !template) {
    return (
      <div className="flex items-center justify-center py-20">
        <span className="inline-flex items-center gap-2 text-sm text-slate-400">
          <svg className="h-6 w-6 animate-spin text-primary-500" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
          </svg>
          در حال بارگذاری محصول…
        </span>
      </div>
    );
  }

  if (error && !template) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <p role="alert" className="text-sm text-red-600">{error}</p>
        <div className="mt-4 flex justify-center gap-2">
          <Button size="sm" onClick={() => void load()}>تلاش مجدد</Button>
          <Link href="/products" tabIndex={-1}>
            <Button size="sm" variant="secondary">بازگشت به فهرست</Button>
          </Link>
        </div>
      </div>
    );
  }

  if (!template) return null;

  const activeIndex = TABS.findIndex((tab) => tab.key === activeTab);

  return (
    <div className="space-y-4">
      <ProductsNav />

      {/* Header */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-bold text-slate-800">{template.nameFa}</h2>
              <span className="inline-flex items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
                {PRODUCT_TYPE_LABELS[template.productType] ?? template.productType}
              </span>
              <StatusBadge archived={!template.active} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
              {template.internalCode && (
                <span>کد داخلی: <span dir="ltr">{template.internalCode}</span></span>
              )}
              <span>گروه: {template.category?.nameFa ?? "—"}</span>
              <span>برند: {template.brand?.nameFa ?? "—"}</span>
              <span>نسخه: {faDigits(template.version)}</span>
              <span>ایجاد: {jalali(template.createdAt)}</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/products" tabIndex={-1}>
              <Button variant="ghost" size="sm">بازگشت</Button>
            </Link>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void handleArchive()}
              disabled={archiving || !template.active}
            >
              {archiving ? "…" : "بایگانی محصول"}
            </Button>
          </div>
        </div>
        {actionError && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {actionError}
          </div>
        )}
      </div>

      {/* Tabs */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div
          role="tablist"
          aria-label="بخش‌های محصول"
          onKeyDown={handleTablistKeyDown}
          className="flex flex-wrap gap-1 overflow-x-auto border-b border-slate-200 bg-slate-50/70 px-2 pt-2"
        >
          {TABS.map((tab, index) => {
            const selected = tab.key === activeTab;
            return (
              <button
                key={tab.key}
                ref={(el) => {
                  tabRefs.current[index] = el;
                }}
                type="button"
                role="tab"
                id={`tab-${tab.key}`}
                aria-selected={selected}
                aria-controls={`panel-${tab.key}`}
                tabIndex={index === activeIndex ? 0 : -1}
                onClick={() => setActiveTab(tab.key)}
                className={`-mb-px rounded-t-md border-b-2 px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  selected
                    ? "border-primary-600 bg-white text-primary-700"
                    : "border-transparent text-slate-500 hover:bg-slate-100 hover:text-slate-700"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div
          role="tabpanel"
          id={`panel-${activeTab}`}
          aria-labelledby={`tab-${activeTab}`}
          className="p-4"
        >
          {activeTab === "general" && <GeneralTab template={template} onChanged={onChanged} />}
          {activeTab === "variants" && <VariantsTab template={template} onChanged={onChanged} />}
          {activeTab === "attributes" && <AttributesTab template={template} onChanged={onChanged} />}
          {activeTab === "uom" && <UomTab template={template} />}
          {activeTab === "suppliers" && <SuppliersTab template={template} onChanged={onChanged} />}
          {activeTab === "files" && <FilesTab template={template} />}
          {activeTab === "history" && <HistoryTab template={template} />}
        </div>
      </div>
    </div>
  );
}
