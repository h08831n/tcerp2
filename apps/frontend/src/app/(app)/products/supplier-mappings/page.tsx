"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/ui/data-table";
import { ProductsNav } from "@/components/products/nav";
import { faDigits } from "@/lib/format";
import {
  SUPPLIER_MAPPING_LEVELS,
  SUPPLIER_MAPPING_LEVEL_LABELS,
  createSupplierMapping,
  fetchAllCategories,
  fetchSupplierMappings,
  fetchTemplate,
  productErrorMessage,
  updateSupplierMapping,
  type CategoryDto,
  type SupplierMappingDto,
  type SupplierMappingLevel,
} from "@/lib/product";

const PAGE_SIZE = 20;

const mapParty = (raw: unknown) => {
  const item = raw as Record<string, unknown>;
  const id = typeof item?.id === "string" ? item.id : "";
  const nameFa = typeof item?.nameFa === "string" ? item.nameFa : "";
  if (!id || !nameFa) return null;
  return { id, label: nameFa };
};

const mapTemplate = (raw: unknown) => {
  const item = raw as Record<string, unknown>;
  const id = typeof item?.id === "string" ? item.id : "";
  const nameFa = typeof item?.nameFa === "string" ? item.nameFa : "";
  if (!id || !nameFa) return null;
  return {
    id,
    label: nameFa,
    sublabel: typeof item?.internalCode === "string" ? item.internalCode : undefined,
  };
};

function targetLabel(mapping: SupplierMappingDto): string {
  if (mapping.mappingLevel === "VARIANT") return mapping.productVariant?.nameFa ?? "—";
  if (mapping.mappingLevel === "TEMPLATE") return mapping.productTemplate?.nameFa ?? "—";
  return mapping.category?.nameFa ?? "—";
}

export default function SupplierMappingsPage() {
  // Filters
  const [supplier, setSupplier] = useState<EntityOption | null>(null);
  const [level, setLevel] = useState<SupplierMappingLevel | "">("");
  const [isActive, setIsActive] = useState<"" | "true" | "false">("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);

  const [data, setData] = useState<{ items: SupplierMappingDto[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Add form
  const [addOpen, setAddOpen] = useState(false);
  const [party, setParty] = useState<EntityOption | null>(null);
  const [addLevel, setAddLevel] = useState<SupplierMappingLevel>("TEMPLATE");
  const [template, setTemplate] = useState<EntityOption | null>(null);
  const [variants, setVariants] = useState<{ id: string; label: string }[]>([]);
  const [variantId, setVariantId] = useState("");
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [supplierCode, setSupplierCode] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const query = useCallback(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      supplierPartyId: supplier?.id || undefined,
      mappingLevel: level || undefined,
      ...(isActive !== "" ? { isActive: isActive === "true" } : {}),
    }),
    [page, supplier, level, isActive],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchSupplierMappings(query());
      setData(result);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, supplier, level, isActive]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(() => {
    let cancelled = false;
    fetchAllCategories("true")
      .then((items) => {
        if (!cancelled) setCategories(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Load variants when a template is picked for variant-level mappings.
  useEffect(() => {
    if (addLevel !== "VARIANT" || !template) {
      setVariants([]);
      setVariantId("");
      return;
    }
    let cancelled = false;
    void fetchTemplate(template.id)
      .then((detail) => {
        if (cancelled) return;
        setVariants(
          detail.variants.map((variant) => ({
            id: variant.id,
            label: `${variant.nameFa} (${variant.sku})`,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setVariants([]);
      });
    return () => {
      cancelled = true;
    };
  }, [addLevel, template]);

  async function handleAdd() {
    if (saving) return;
    setFormError(null);
    if (!party) {
      setFormError("انتخاب تامین‌کننده الزامی است.");
      return;
    }
    if (addLevel === "TEMPLATE" && !template) {
      setFormError("برای سطح «خانواده محصول» انتخاب محصول الزامی است.");
      return;
    }
    if (addLevel === "VARIANT" && (!template || !variantId)) {
      setFormError("برای سطح «محصول» انتخاب محصول و variant الزامی است.");
      return;
    }
    if (addLevel === "CATEGORY" && !categoryId) {
      setFormError("برای سطح «گروه» انتخاب گروه الزامی است.");
      return;
    }
    setSaving(true);
    try {
      await createSupplierMapping({
        supplierPartyId: party.id,
        mappingLevel: addLevel,
        ...(addLevel === "VARIANT"
          ? { productVariantId: variantId, productTemplateId: template?.id }
          : addLevel === "TEMPLATE"
            ? { productTemplateId: template?.id }
            : { categoryId }),
        supplierProductCode: supplierCode.trim() || undefined,
        supplierProductName: supplierName.trim() || undefined,
        isActive: true,
      });
      setParty(null);
      setTemplate(null);
      setVariantId("");
      setCategoryId("");
      setSupplierCode("");
      setSupplierName("");
      setAddOpen(false);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S in the add form.
  useEffect(() => {
    if (!addOpen) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleAdd();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addOpen, party, template, variantId, categoryId, supplierCode, supplierName, saving]);

  async function toggleActive(mapping: SupplierMappingDto) {
    setSaving(true);
    setError(null);
    try {
      await updateSupplierMapping(mapping.id, { isActive: !mapping.isActive });
      await load();
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // The endpoint orders by createdAt desc; level sorts are applied to the loaded page.
  const rows = (() => {
    const items = [...(data?.items ?? [])];
    if (sort?.key === "mappingLevel") {
      items.sort((a, b) =>
        sort.dir === "asc"
          ? a.mappingLevel.localeCompare(b.mappingLevel)
          : b.mappingLevel.localeCompare(a.mappingLevel),
      );
    }
    return items;
  })();

  const columns: DataTableColumn<SupplierMappingDto>[] = [
    {
      key: "supplier",
      header: "تامین‌کننده",
      render: (row) => row.supplierParty.nameFa,
    },
    {
      key: "mappingLevel",
      header: "سطح",
      render: (row) => (
        <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
          {SUPPLIER_MAPPING_LEVEL_LABELS[row.mappingLevel] ?? row.mappingLevel}
        </span>
      ),
    },
    {
      key: "target",
      header: "هدف",
      render: (row) => targetLabel(row),
    },
    {
      key: "supplierProductCode",
      header: "کد تامین‌کننده",
      render: (row) => (row.supplierProductCode ? (
        <span dir="ltr" className="block text-start tabular-nums">{row.supplierProductCode}</span>
      ) : (
        <span className="text-slate-400">—</span>
      )),
    },
    {
      key: "supplierProductName",
      header: "نام تامین‌کننده",
      render: (row) => row.supplierProductName ?? <span className="text-slate-400">—</span>,
    },
    {
      key: "isActive",
      header: "وضعیت",
      align: "center",
      render: (row) => (
        <button
          type="button"
          onClick={() => void toggleActive(row)}
          disabled={saving}
          aria-label={`${row.isActive ? "غیرفعال کردن" : "فعال کردن"} نگاشت ${row.supplierParty.nameFa}`}
          className={`rounded border px-1.5 py-0.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
            row.isActive
              ? "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              : "border-red-200 bg-red-50 text-red-600 hover:bg-red-100"
          }`}
        >
          {row.isActive ? "فعال" : "غیرفعال"}
        </button>
      ),
    },
  ];

  const selectClass =
    "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20";

  return (
    <div className="space-y-4">
      <ProductsNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">نگاشت تامین‌کنندگان</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            نگاشت تامین‌کننده به محصول، خانواده محصول یا گروه کالا
          </p>
        </div>
        <Button size="sm" onClick={() => setAddOpen((open) => !open)} aria-expanded={addOpen}>
          {addOpen ? "بستن فرم" : "نگاشت جدید"}
        </Button>
      </div>

      {/* Add form */}
      {addOpen && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <span className="mb-1 block text-xs font-medium text-slate-600">تامین‌کننده *</span>
              <EntitySelector
                endpoint={(search) => `/parties?role=SUPPLIER&search=${encodeURIComponent(search)}&pageSize=20`}
                mapItem={mapParty}
                value={party}
                onChange={setParty}
                placeholder="جستجوی تامین‌کننده…"
                ariaLabel="انتخاب تامین‌کننده"
                emptySearchLabel="برای جستجو تایپ کنید"
              />
            </div>
            <div>
              <label htmlFor="all-sm-level" className="mb-1 block text-xs font-medium text-slate-600">سطح نگاشت *</label>
              <select
                id="all-sm-level"
                value={addLevel}
                onChange={(event) => {
                  setAddLevel(event.target.value as SupplierMappingLevel);
                  setVariantId("");
                }}
                className={selectClass}
              >
                {SUPPLIER_MAPPING_LEVELS.map((value) => (
                  <option key={value} value={value}>{SUPPLIER_MAPPING_LEVEL_LABELS[value]}</option>
                ))}
              </select>
            </div>
            {addLevel === "CATEGORY" ? (
              <div>
                <label htmlFor="all-sm-category" className="mb-1 block text-xs font-medium text-slate-600">گروه *</label>
                <select
                  id="all-sm-category"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                  className={selectClass}
                >
                  <option value="">انتخاب کنید…</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>{category.nameFa}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-600">
                  محصول {addLevel === "TEMPLATE" ? "*" : "*"}
                </span>
                <EntitySelector
                  endpoint={(search) => `/products/templates?search=${encodeURIComponent(search)}&active=true&pageSize=20`}
                  mapItem={mapTemplate}
                  value={template}
                  onChange={setTemplate}
                  placeholder="جستجوی محصول…"
                  ariaLabel="انتخاب محصول"
                  emptySearchLabel="برای جستجوی محصول تایپ کنید"
                />
              </div>
            )}
            {addLevel === "VARIANT" && (
              <div>
                <label htmlFor="all-sm-variant" className="mb-1 block text-xs font-medium text-slate-600">variant *</label>
                <select
                  id="all-sm-variant"
                  value={variantId}
                  onChange={(event) => setVariantId(event.target.value)}
                  className={selectClass}
                  disabled={!template || variants.length === 0}
                >
                  <option value="">
                    {template ? (variants.length === 0 ? "این محصول variant ندارد" : "انتخاب کنید…") : "ابتدا محصول را انتخاب کنید"}
                  </option>
                  {variants.map((variant) => (
                    <option key={variant.id} value={variant.id}>{variant.label}</option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label htmlFor="all-sm-code" className="mb-1 block text-xs font-medium text-slate-600">کد کالا نزد تامین‌کننده</label>
              <Input id="all-sm-code" dir="ltr" value={supplierCode}
                onChange={(event) => setSupplierCode(event.target.value)} />
            </div>
            <div>
              <label htmlFor="all-sm-name" className="mb-1 block text-xs font-medium text-slate-600">نام کالا نزد تامین‌کننده</label>
              <Input id="all-sm-name" value={supplierName}
                onChange={(event) => setSupplierName(event.target.value)} />
            </div>
          </div>
          {formError && (
            <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => void handleAdd()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
            </Button>
            <Button size="sm" variant="secondary" onClick={() => {
              setAddOpen(false);
              setFormError(null);
            }} disabled={saving}>
              انصراف (Esc)
            </Button>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-64">
          <span className="mb-1 block text-xs font-medium text-slate-600">تامین‌کننده</span>
          <EntitySelector
            endpoint={(search) => `/parties?role=SUPPLIER&search=${encodeURIComponent(search)}&pageSize=20`}
            mapItem={mapParty}
            value={supplier}
            onChange={(value) => {
              setSupplier(value);
              setPage(1);
            }}
            placeholder="همه تامین‌کنندگان"
            ariaLabel="فیلتر تامین‌کننده"
            emptySearchLabel="برای جستجو تایپ کنید"
          />
        </div>
        <div className="w-44">
          <label htmlFor="filter-level" className="mb-1 block text-xs font-medium text-slate-600">سطح</label>
          <select
            id="filter-level"
            value={level}
            onChange={(event) => {
              setLevel(event.target.value as SupplierMappingLevel | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {SUPPLIER_MAPPING_LEVELS.map((value) => (
              <option key={value} value={value}>{SUPPLIER_MAPPING_LEVEL_LABELS[value]}</option>
            ))}
          </select>
        </div>
        <div className="w-36">
          <label htmlFor="filter-active" className="mb-1 block text-xs font-medium text-slate-600">وضعیت</label>
          <select
            id="filter-active"
            value={isActive}
            onChange={(event) => {
              setIsActive(event.target.value as "" | "true" | "false");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            <option value="true">فعال</option>
            <option value="false">غیرفعال</option>
          </select>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}{" "}
          <button type="button" className="font-bold underline" onClick={() => setReloadToken((token) => token + 1)}>
            تلاش مجدد
          </button>
        </div>
      )}

      <DataTable<SupplierMappingDto>
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        sort={sort}
        onSortChange={setSort}
        loading={loading}
        dense
        ariaLabel="فهرست نگاشت تامین‌کنندگان"
        emptyMessage="نگاشتی یافت نشد."
        pagination={
          data
            ? {
                page: data.page,
                pageSize: data.pageSize,
                total: data.total,
                onPageChange: setPage,
              }
            : null
        }
      />

      {data && (
        <p className="text-xs text-slate-400">مجموع {faDigits(data.total)} نگاشت</p>
      )}
    </div>
  );
}
