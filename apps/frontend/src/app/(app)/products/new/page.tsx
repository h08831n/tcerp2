"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import {
  PRODUCT_TYPES,
  PRODUCT_TYPE_LABELS,
  createTemplate,
  fetchTaxDefinitions,
  parseDecimalInput,
  productErrorMessage,
  type ProductType,
  type TaxDefinitionDto,
} from "@/lib/product";
import { faMoney } from "@/lib/format";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

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
  return {
    id,
    label: symbol ? `${nameFa} (${symbol})` : nameFa,
    sublabel:
      item?.category && typeof (item.category as { nameFa?: unknown })?.nameFa === "string"
        ? (item.category as { nameFa: string }).nameFa
        : undefined,
  };
};

export default function NewProductPage() {
  const router = useRouter();

  const [nameFa, setNameFa] = useState("");
  const [nameEn, setNameEn] = useState("");
  const [internalCode, setInternalCode] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<EntityOption | null>(null);
  const [brand, setBrand] = useState<EntityOption | null>(null);
  const [productType, setProductType] = useState<ProductType>("STORABLE");
  const [isSellable, setIsSellable] = useState(true);
  const [isPurchasable, setIsPurchasable] = useState(true);
  const [salesPriceInput, setSalesPriceInput] = useState("");
  const [salesUom, setSalesUom] = useState<EntityOption | null>(null);
  const [purchaseUom, setPurchaseUom] = useState<EntityOption | null>(null);
  const [taxDefinitions, setTaxDefinitions] = useState<TaxDefinitionDto[] | null>(null);
  const [taxDefinitionId, setTaxDefinitionId] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchTaxDefinitions()
      .then((items) => {
        if (!cancelled) setTaxDefinitions(items);
      })
      .catch(() => {
        if (!cancelled) setTaxDefinitions([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const parsedPrice = useMemo(() => parseDecimalInput(salesPriceInput), [salesPriceInput]);

  const categoriesEndpoint = (search: string) =>
    `/categories?search=${encodeURIComponent(search)}&active=true&pageSize=50`;
  const brandsEndpoint = (search: string) =>
    `/brands?search=${encodeURIComponent(search)}&active=true&pageSize=50`;
  const uomsEndpoint = () => "/uoms?active=true";

  async function save() {
    if (submitting) return;
    setFormError(null);
    if (!nameFa.trim()) {
      setFormError("نام فارسی محصول الزامی است.");
      return;
    }
    if (!category) {
      setFormError("انتخاب گروه کالا الزامی است.");
      return;
    }
    setSubmitting(true);
    try {
      const created = await createTemplate({
        categoryId: category.id,
        brandId: brand?.id || undefined,
        nameFa: nameFa.trim(),
        nameEn: nameEn.trim() || undefined,
        internalCode: internalCode.trim() || undefined,
        description: description.trim() || undefined,
        productType,
        isSellable,
        isPurchasable,
        defaultSalesUomId: salesUom?.id || undefined,
        defaultPurchaseUomId: purchaseUom?.id || undefined,
        defaultSalesPrice: parsedPrice || undefined,
        defaultTaxDefinitionId: taxDefinitionId || undefined,
      });
      router.push(`/products/${created.id}`);
    } catch (err) {
      setFormError(productErrorMessage(err));
      setSubmitting(false);
    }
  }

  // Ctrl+S / Cmd+S saves the form.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submitting, nameFa, nameEn, internalCode, description, category, brand, productType, isSellable, isPurchasable, parsedPrice, salesUom, purchaseUom, taxDefinitionId]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    void save();
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">محصول جدید</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            ثبت خانواده محصول (Product Template)
          </p>
        </div>
        <Link href="/products" tabIndex={-1}>
          <Button variant="ghost" size="sm">بازگشت</Button>
        </Link>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <label htmlFor="p-nameFa" className={fieldLabel}>نام فارسی *</label>
            <Input
              id="p-nameFa"
              value={nameFa}
              onChange={(event) => setNameFa(event.target.value)}
              aria-label="نام فارسی محصول"
            />
          </div>
          <div>
            <label htmlFor="p-nameEn" className={fieldLabel}>نام لاتین</label>
            <Input
              id="p-nameEn"
              dir="ltr"
              value={nameEn}
              onChange={(event) => setNameEn(event.target.value)}
              aria-label="نام لاتین محصول"
            />
          </div>
          <div>
            <label htmlFor="p-internalCode" className={fieldLabel}>کد داخلی</label>
            <Input
              id="p-internalCode"
              dir="ltr"
              value={internalCode}
              onChange={(event) => setInternalCode(event.target.value)}
              aria-label="کد داخلی محصول"
            />
          </div>

          <div>
            <span className={fieldLabel}>گروه کالا *</span>
            <EntitySelector
              endpoint={categoriesEndpoint}
              mapItem={mapCategory}
              value={category}
              onChange={setCategory}
              placeholder="جستجوی گروه…"
              ariaLabel="انتخاب گروه کالا"
              emptySearchLabel="برای جستجوی گروه تایپ کنید"
            />
          </div>
          <div>
            <span className={fieldLabel}>برند</span>
            <EntitySelector
              endpoint={brandsEndpoint}
              mapItem={mapCategory}
              value={brand}
              onChange={setBrand}
              placeholder="جستجوی برند…"
              ariaLabel="انتخاب برند"
              emptySearchLabel="برای جستجوی برند تایپ کنید"
            />
          </div>
          <div>
            <label htmlFor="p-productType" className={fieldLabel}>نوع محصول</label>
            <select
              id="p-productType"
              value={productType}
              onChange={(event) => setProductType(event.target.value as ProductType)}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              {PRODUCT_TYPES.map((value) => (
                <option key={value} value={value}>
                  {PRODUCT_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className={fieldLabel}>واحد فروش</span>
            <EntitySelector
              endpoint={uomsEndpoint}
              mapItem={mapUom}
              value={salesUom}
              onChange={setSalesUom}
              placeholder="انتخاب واحد فروش…"
              ariaLabel="انتخاب واحد فروش"
              emptySearchLabel="همه واحدهای فعال"
            />
          </div>
          <div>
            <span className={fieldLabel}>واحد خرید</span>
            <EntitySelector
              endpoint={uomsEndpoint}
              mapItem={mapUom}
              value={purchaseUom}
              onChange={setPurchaseUom}
              placeholder="انتخاب واحد خرید…"
              ariaLabel="انتخاب واحد خرید"
              emptySearchLabel="همه واحدهای فعال"
            />
          </div>
          <div>
            <label htmlFor="p-price" className={fieldLabel}>قیمت پیش‌فرض فروش (ریال)</label>
            <Input
              id="p-price"
              dir="ltr"
              inputMode="decimal"
              value={salesPriceInput}
              onChange={(event) => setSalesPriceInput(event.target.value)}
              aria-label="قیمت پیش‌فرض فروش به ریال"
            />
            {parsedPrice && (
              <p className="mt-1 text-[11px] text-slate-400">{faMoney(Number(parsedPrice))}</p>
            )}
          </div>

          {taxDefinitions && taxDefinitions.length > 0 && (
            <div>
              <label htmlFor="p-tax" className={fieldLabel}>تعریف مالیات پیش‌فرض</label>
              <select
                id="p-tax"
                value={taxDefinitionId}
                onChange={(event) => setTaxDefinitionId(event.target.value)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                <option value="">بدون مالیات</option>
                {taxDefinitions.map((definition) => (
                  <option key={definition.id} value={definition.id}>
                    {definition.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="flex items-end gap-6 pb-1">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isSellable}
                onChange={(event) => setIsSellable(event.target.checked)}
                className="h-4 w-4 accent-primary-600"
              />
              قابل فروش
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={isPurchasable}
                onChange={(event) => setIsPurchasable(event.target.checked)}
                className="h-4 w-4 accent-primary-600"
              />
              قابل خرید
            </label>
          </div>
        </div>

        <div className="mt-4">
          <label htmlFor="p-description" className={fieldLabel}>توضیحات</label>
          <textarea
            id="p-description"
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          />
        </div>

        {formError && (
          <div
            role="alert"
            className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          >
            {formError}
          </div>
        )}

        <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
          </Button>
          <Link href="/products" tabIndex={-1}>
            <Button variant="secondary" disabled={submitting}>انصراف</Button>
          </Link>
        </div>
      </div>
    </form>
  );
}
