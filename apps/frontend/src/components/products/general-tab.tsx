"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import {
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABELS,
  fetchTaxDefinitions,
  fetchTemplate,
  parseDecimalInput,
  productErrorMessage,
  updateTemplate,
  type ProductType,
  type TaxDefinitionDto,
  type TemplateDetail,
} from "@/lib/product";
import { faMoney } from "@/lib/format";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

interface FormState {
  nameFa: string;
  nameEn: string;
  internalCode: string;
  description: string;
  category: EntityOption | null;
  brand: EntityOption | null;
  productType: ProductType;
  isSellable: boolean;
  isPurchasable: boolean;
  salesPrice: string;
  salesUom: EntityOption | null;
  purchaseUom: EntityOption | null;
  taxDefinitionId: string;
}

function toFormState(template: TemplateDetail): FormState {
  return {
    nameFa: template.nameFa ?? "",
    nameEn: template.nameEn ?? "",
    internalCode: template.internalCode ?? "",
    description: template.description ?? "",
    category: template.category
      ? { id: template.category.id, label: template.category.nameFa, sublabel: template.category.code }
      : null,
    brand: template.brand
      ? { id: template.brand.id, label: template.brand.nameFa, sublabel: template.brand.code }
      : null,
    productType: template.productType,
    isSellable: template.isSellable,
    isPurchasable: template.isPurchasable,
    salesPrice: template.defaultSalesPrice ?? "",
    salesUom: template.salesUom
      ? { id: template.salesUom.id, label: `${template.salesUom.nameFa} (${template.salesUom.symbol})` }
      : null,
    purchaseUom: template.purchaseUom
      ? { id: template.purchaseUom.id, label: `${template.purchaseUom.nameFa} (${template.purchaseUom.symbol})` }
      : null,
    taxDefinitionId: template.taxDefinition?.id ?? "",
  };
}

const mapCategory = (raw: unknown) => {
  const item = raw as Record<string, unknown>;
  const id = typeof item?.id === "string" ? item.id : "";
  const nameFa = typeof item?.nameFa === "string" ? item.nameFa : "";
  if (!id || !nameFa) return null;
  return {
    id,
    label: nameFa,
    sublabel: typeof item?.code === "string" ? item.code : undefined,
  };
};

const mapUom = (raw: unknown) => {
  const item = raw as Record<string, unknown>;
  const id = typeof item?.id === "string" ? item.id : "";
  const nameFa = typeof item?.nameFa === "string" ? item.nameFa : "";
  if (!id || !nameFa) return null;
  const symbol = typeof item?.symbol === "string" ? item.symbol : "";
  return { id, label: symbol ? `${nameFa} (${symbol})` : nameFa };
};

export function GeneralTab({
  template,
  onChanged,
}: {
  template: TemplateDetail;
  onChanged: (template: TemplateDetail) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(() => toFormState(template));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [taxDefinitions, setTaxDefinitions] = useState<TaxDefinitionDto[]>([]);
  const editButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    let cancelled = false;
    fetchTaxDefinitions()
      .then((items) => {
        if (!cancelled) setTaxDefinitions(items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [editing]);

  function startEdit() {
    setForm(toFormState(template));
    setError(null);
    setConflict(false);
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setError(null);
    setConflict(false);
    editButtonRef.current?.focus();
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    setError(null);
    setConflict(false);
    try {
      const parsedPrice = parseDecimalInput(form.salesPrice);
      await updateTemplate(template.id, {
        version: template.version,
        nameFa: form.nameFa.trim(),
        nameEn: form.nameEn.trim() || undefined,
        internalCode: form.internalCode.trim() || undefined,
        description: form.description.trim() || undefined,
        categoryId: form.category?.id,
        brandId: form.brand?.id ?? null,
        productType: form.productType,
        isSellable: form.isSellable,
        isPurchasable: form.isPurchasable,
        defaultSalesUomId: form.salesUom?.id || undefined,
        defaultPurchaseUomId: form.purchaseUom?.id || undefined,
        defaultSalesPrice: parsedPrice || undefined,
        defaultTaxDefinitionId: form.taxDefinitionId || undefined,
      });
      onChanged(await fetchTemplate(template.id));
      setEditing(false);
      editButtonRef.current?.focus();
    } catch (err) {
      if (err instanceof Error && err.message.includes("VERSION_CONFLICT")) {
        setConflict(true);
      } else if (err instanceof Error && err.name === "ApiError" && (err as { status?: number }).status === 409) {
        setConflict(true);
      } else {
        setError(productErrorMessage(err));
      }
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S / Cmd+S saves while editing.
  useEffect(() => {
    if (!editing) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, form, template.version, saving]);

  // Escape exits edit mode.
  useEffect(() => {
    if (!editing) return;
    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        const target = event.target as HTMLElement | null;
        if (target?.closest("input,textarea,select")) return;
        cancelEdit();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, template.version]);

  const categoriesEndpoint = (search: string) =>
    `/categories?search=${encodeURIComponent(search)}&active=true&pageSize=50`;
  const brandsEndpoint = (search: string) =>
    `/brands?search=${encodeURIComponent(search)}&active=true&pageSize=50`;
  const uomsEndpoint = () => "/uoms?active=true";

  if (editing) {
    const parsedPrice = parseDecimalInput(form.salesPrice);
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-bold text-slate-800">ویرایش محصول</h3>

        {conflict && (
          <div
            role="alert"
            className="mb-4 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800"
          >
            <p className="font-bold">رکورد توسط کاربر دیگری تغییر کرده است.</p>
            <p className="mt-1 text-xs">
              برای مشاهده نسخه جدید، صفحه را بازخوانی کنید؛ تغییرات شما ذخیره نشد.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => window.location.reload()}>
                بازخوانی صفحه
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setConflict(false)}>
                بستن
              </Button>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="tg-nameFa" className={fieldLabel}>نام فارسی *</label>
            <Input id="tg-nameFa" value={form.nameFa}
              onChange={(e) => setForm({ ...form, nameFa: e.target.value })} />
          </div>
          <div>
            <label htmlFor="tg-nameEn" className={fieldLabel}>نام لاتین</label>
            <Input id="tg-nameEn" dir="ltr" value={form.nameEn}
              onChange={(e) => setForm({ ...form, nameEn: e.target.value })} />
          </div>
          <div>
            <label htmlFor="tg-internalCode" className={fieldLabel}>کد داخلی</label>
            <Input id="tg-internalCode" dir="ltr" value={form.internalCode}
              onChange={(e) => setForm({ ...form, internalCode: e.target.value })} />
          </div>
          <div>
            <span className={fieldLabel}>گروه کالا</span>
            <EntitySelector
              endpoint={categoriesEndpoint}
              mapItem={mapCategory}
              value={form.category}
              onChange={(value) => setForm({ ...form, category: value })}
              placeholder="جستجوی گروه…"
              ariaLabel="انتخاب گروه کالا"
            />
          </div>
          <div>
            <span className={fieldLabel}>برند</span>
            <EntitySelector
              endpoint={brandsEndpoint}
              mapItem={mapCategory}
              value={form.brand}
              onChange={(value) => setForm({ ...form, brand: value })}
              placeholder="جستجوی برند…"
              ariaLabel="انتخاب برند"
            />
          </div>
          <div>
            <label htmlFor="tg-productType" className={fieldLabel}>نوع محصول</label>
            <select
              id="tg-productType"
              value={form.productType}
              onChange={(e) => setForm({ ...form, productType: e.target.value as ProductType })}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              {PRODUCT_TYPES.map((value) => (
                <option key={value} value={value}>{PRODUCT_TYPE_LABELS[value]}</option>
              ))}
            </select>
          </div>
          <div>
            <span className={fieldLabel}>واحد فروش</span>
            <EntitySelector
              endpoint={uomsEndpoint}
              mapItem={mapUom}
              value={form.salesUom}
              onChange={(value) => setForm({ ...form, salesUom: value })}
              placeholder="انتخاب واحد فروش…"
              ariaLabel="انتخاب واحد فروش"
            />
          </div>
          <div>
            <span className={fieldLabel}>واحد خرید</span>
            <EntitySelector
              endpoint={uomsEndpoint}
              mapItem={mapUom}
              value={form.purchaseUom}
              onChange={(value) => setForm({ ...form, purchaseUom: value })}
              placeholder="انتخاب واحد خرید…"
              ariaLabel="انتخاب واحد خرید"
            />
          </div>
          <div>
            <label htmlFor="tg-price" className={fieldLabel}>قیمت پیش‌فرض فروش (ریال)</label>
            <Input id="tg-price" dir="ltr" inputMode="decimal" value={form.salesPrice}
              onChange={(e) => setForm({ ...form, salesPrice: e.target.value })} />
            {parsedPrice && (
              <p className="mt-1 text-[11px] text-slate-400">{faMoney(Number(parsedPrice))}</p>
            )}
          </div>
          {taxDefinitions.length > 0 && (
            <div>
              <label htmlFor="tg-tax" className={fieldLabel}>تعریف مالیات پیش‌فرض</label>
              <select
                id="tg-tax"
                value={form.taxDefinitionId}
                onChange={(e) => setForm({ ...form, taxDefinitionId: e.target.value })}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                <option value="">بدون مالیات</option>
                {taxDefinitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>{definition.name}</option>
                ))}
              </select>
            </div>
          )}
          <div className="flex items-end gap-6 pb-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.isSellable}
                onChange={(e) => setForm({ ...form, isSellable: e.target.checked })}
                className="h-4 w-4 accent-primary-600" />
              قابل فروش
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={form.isPurchasable}
                onChange={(e) => setForm({ ...form, isPurchasable: e.target.checked })}
                className="h-4 w-4 accent-primary-600" />
              قابل خرید
            </label>
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="tg-description" className={fieldLabel}>توضیحات</label>
          <textarea
            id="tg-description"
            rows={3}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>

        {error && (
          <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
          </Button>
          <Button variant="secondary" onClick={cancelEdit} disabled={saving}>
            انصراف (Esc)
          </Button>
        </div>
      </div>
    );
  }

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "نام فارسی", value: template.nameFa },
    { label: "نام لاتین", value: template.nameEn ?? "—" },
    { label: "کد داخلی", value: template.internalCode ?? "—" },
    { label: "گروه کالا", value: template.category?.nameFa ?? "—" },
    { label: "برند", value: template.brand?.nameFa ?? "—" },
    { label: "نوع محصول", value: PRODUCT_TYPE_LABELS[template.productType] ?? template.productType },
    { label: "قیمت پیش‌فرض فروش", value: template.defaultSalesPrice ? faMoney(Number(template.defaultSalesPrice)) : "—" },
    { label: "واحد فروش", value: template.salesUom ? `${template.salesUom.nameFa} (${template.salesUom.symbol})` : "—" },
    { label: "واحد خرید", value: template.purchaseUom ? `${template.purchaseUom.nameFa} (${template.purchaseUom.symbol})` : "—" },
    { label: "تعریف مالیات پیش‌فرض", value: template.taxDefinition?.name ?? "—" },
    { label: "قابل فروش", value: template.isSellable ? "بله" : "خیر" },
    { label: "قابل خرید", value: template.isPurchasable ? "بله" : "خیر" },
  ];

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-bold text-slate-800">اطلاعات عمومی</h3>
        <Button ref={editButtonRef} variant="secondary" size="sm" onClick={startEdit}>
          ویرایش
        </Button>
      </div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="min-w-0">
            <dt className="text-[11px] text-slate-400">{row.label}</dt>
            <dd className="mt-0.5 truncate text-sm text-slate-800">{row.value || "—"}</dd>
          </div>
        ))}
        {template.description && (
          <div className="sm:col-span-2 lg:col-span-3">
            <dt className="text-[11px] text-slate-400">توضیحات</dt>
            <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-700">{template.description}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
