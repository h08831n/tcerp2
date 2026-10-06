"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { faDigits } from "@/lib/format";
import {
  SUPPLIER_MAPPING_LEVELS,
  SUPPLIER_MAPPING_LEVEL_LABELS,
  createSupplierMapping,
  fetchSupplierMappings,
  productErrorMessage,
  type SupplierMappingDto,
  type SupplierMappingLevel,
  type TemplateDetail,
} from "@/lib/product";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

const mapParty = (raw: unknown) => {
  const item = raw as Record<string, unknown>;
  const id = typeof item?.id === "string" ? item.id : "";
  const nameFa = typeof item?.nameFa === "string" ? item.nameFa : "";
  if (!id || !nameFa) return null;
  const phone =
    item?.primaryPhone &&
    typeof (item.primaryPhone as { normalizedValue?: unknown })?.normalizedValue === "string"
      ? (item.primaryPhone as { normalizedValue: string }).normalizedValue
      : undefined;
  return { id, label: nameFa, sublabel: phone };
};

function targetLabel(mapping: SupplierMappingDto): string {
  if (mapping.mappingLevel === "VARIANT") return mapping.productVariant?.nameFa ?? "—";
  if (mapping.mappingLevel === "TEMPLATE") return mapping.productTemplate?.nameFa ?? "—";
  return mapping.category?.nameFa ?? "—";
}

export function SuppliersTab({
  template,
  onChanged,
}: {
  template: TemplateDetail;
  onChanged: (template: TemplateDetail) => void;
}) {
  const [mappings, setMappings] = useState<SupplierMappingDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [party, setParty] = useState<EntityOption | null>(null);
  const [mappingLevel, setMappingLevel] = useState<SupplierMappingLevel>("TEMPLATE");
  const [variantId, setVariantId] = useState("");
  const [supplierCode, setSupplierCode] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const variantIds = new Set(template.variants.map((variant) => variant.id));

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // The list endpoint has no templateId filter; load a page and keep the
      // rows that point at this template or at one of its variants.
      const response = await fetchSupplierMappings({ page: 1, pageSize: 100 });
      const relevant = response.items.filter(
        (mapping) =>
          mapping.productTemplateId === template.id ||
          (mapping.productVariantId !== null && variantIds.has(mapping.productVariantId)),
      );
      setMappings(relevant);
      if (response.total > 100) {
        setError("برخی نگاشت‌ها ممکن است نمایش داده نشده باشند؛ فهرست کامل در صفحه «تامین‌کنندگان» موجود است.");
      }
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template.id, template.variants]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleAdd() {
    if (saving) return;
    setFormError(null);
    if (!party) {
      setFormError("انتخاب تامین‌کننده الزامی است.");
      return;
    }
    if (mappingLevel === "VARIANT" && !variantId) {
      setFormError("برای سطح «محصول» باید یک variant انتخاب کنید.");
      return;
    }
    setSaving(true);
    try {
      await createSupplierMapping({
        supplierPartyId: party.id,
        mappingLevel,
        ...(mappingLevel === "VARIANT"
          ? { productVariantId: variantId }
          : { productTemplateId: template.id }),
        supplierProductCode: supplierCode.trim() || undefined,
        supplierProductName: supplierName.trim() || undefined,
        notes: notes.trim() || undefined,
        isActive: true,
      });
      setParty(null);
      setVariantId("");
      setSupplierCode("");
      setSupplierName("");
      setNotes("");
      setNotice("نگاشت تامین‌کننده اضافه شد.");
      await load();
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S adds the mapping.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleAdd();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party, mappingLevel, variantId, supplierCode, supplierName, notes, saving]);

  return (
    <div className="space-y-4">
      {/* Add form */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-slate-800">افزودن نگاشت تامین‌کننده</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <span className={fieldLabel}>تامین‌کننده *</span>
            <EntitySelector
              endpoint={(search) => `/parties?role=SUPPLIER&search=${encodeURIComponent(search)}&pageSize=20`}
              mapItem={mapParty}
              value={party}
              onChange={setParty}
              placeholder="جستجوی تامین‌کننده…"
              ariaLabel="انتخاب تامین‌کننده"
              emptySearchLabel="برای جستجوی تامین‌کننده تایپ کنید"
            />
          </div>
          <div>
            <label htmlFor="sm-level" className={fieldLabel}>سطح نگاشت</label>
            <select
              id="sm-level"
              value={mappingLevel}
              onChange={(event) => {
                setMappingLevel(event.target.value as SupplierMappingLevel);
                setVariantId("");
              }}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="TEMPLATE">{SUPPLIER_MAPPING_LEVEL_LABELS.TEMPLATE} (این محصول)</option>
              <option value="VARIANT">{SUPPLIER_MAPPING_LEVEL_LABELS.VARIANT} (یک variant)</option>
            </select>
          </div>
          {mappingLevel === "VARIANT" && (
            <div>
              <label htmlFor="sm-variant" className={fieldLabel}>variant *</label>
              <select
                id="sm-variant"
                value={variantId}
                onChange={(event) => setVariantId(event.target.value)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                <option value="">انتخاب کنید…</option>
                {template.variants.map((variant) => (
                  <option key={variant.id} value={variant.id}>
                    {variant.nameFa} ({variant.sku})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div>
            <label htmlFor="sm-code" className={fieldLabel}>کد کالا نزد تامین‌کننده</label>
            <Input
              id="sm-code"
              dir="ltr"
              value={supplierCode}
              onChange={(event) => setSupplierCode(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="sm-name" className={fieldLabel}>نام کالا نزد تامین‌کننده</label>
            <Input
              id="sm-name"
              value={supplierName}
              onChange={(event) => setSupplierName(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="sm-notes" className={fieldLabel}>یادداشت</label>
            <Input
              id="sm-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" onClick={() => void handleAdd()} disabled={saving || !party}>
            افزودن نگاشت
          </Button>
          <span className="text-[11px] text-slate-400">میان‌بر: Ctrl+S</span>
        </div>
        {formError && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {formError}
          </div>
        )}
        {notice && !formError && (
          <p className="mt-3 text-xs text-emerald-700" role="status">{notice}</p>
        )}
      </div>

      {/* Mappings table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">
            نگاشت‌های این محصول — {faDigits(mappings.length)} ردیف
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="نگاشت‌های تامین‌کنندگان محصول">
            <thead>
              <tr className="bg-white text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-start">تامین‌کننده</th>
                <th scope="col" className="px-4 py-2 text-start">سطح</th>
                <th scope="col" className="px-4 py-2 text-start">هدف</th>
                <th scope="col" className="px-4 py-2 text-start">کد تامین‌کننده</th>
                <th scope="col" className="px-4 py-2 text-start">نام تامین‌کننده</th>
                <th scope="col" className="px-4 py-2 text-center">وضعیت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-slate-400">در حال بارگذاری…</td>
                </tr>
              ) : mappings.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-xs text-slate-400">
                    هنوز نگاشتی ثبت نشده است.
                  </td>
                </tr>
              ) : (
                mappings.map((mapping) => (
                  <tr key={mapping.id} className="text-slate-700 hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-800">{mapping.supplierParty.nameFa}</td>
                    <td className="px-4 py-2">
                      <span className="rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
                        {SUPPLIER_MAPPING_LEVEL_LABELS[mapping.mappingLevel] ?? mapping.mappingLevel}
                      </span>
                    </td>
                    <td className="px-4 py-2">{targetLabel(mapping)}</td>
                    <td className="px-4 py-2" dir="ltr">{mapping.supplierProductCode ?? "—"}</td>
                    <td className="px-4 py-2">{mapping.supplierProductName ?? "—"}</td>
                    <td className="px-4 py-2 text-center">
                      {mapping.isActive ? (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">فعال</span>
                      ) : (
                        <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">غیرفعال</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      {error && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          {error}
        </div>
      )}
      <p className="text-xs text-slate-400">
        سطوح مجاز: {SUPPLIER_MAPPING_LEVELS.map((level) => SUPPLIER_MAPPING_LEVEL_LABELS[level]).join("، ")}
        {" "}— نگاشت سطح «گروه» از صفحه نگاشت تامین‌کنندگان قابل ثبت است.
      </p>
    </div>
  );
}
