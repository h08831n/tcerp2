"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { faDigits, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import { createPurchase, purchaseErrorMessage } from "@/lib/purchase";
import { fetchPaymentTerms, type PaymentTermDto } from "@/lib/crm";

function partyMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  return { id, label: typeof item.nameFa === "string" && item.nameFa ? item.nameFa : id };
}

function userMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const name = [item.firstName, item.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();
  return { id, label: name || (typeof item.username === "string" ? item.username : id) };
}

interface DraftLine {
  key: string;
  variant: VariantSelection;
  quantity: string;
  unitPrice: string;
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function NewPurchasePage() {
  const router = useRouter();

  const [supplier, setSupplier] = useState<EntityOption | null>(null);
  const [buyer, setBuyer] = useState<EntityOption | null>(null);
  const [documentDate, setDocumentDate] = useState<string | null>(todayIso());
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermDto[]>([]);
  const [paymentTermId, setPaymentTermId] = useState("");

  const [lines, setLines] = useState<DraftLine[]>([]);
  const [variant, setVariant] = useState<VariantSelection | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [lineError, setLineError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchPaymentTerms(true)
      .then((terms) => {
        if (!cancelled) setPaymentTerms(terms);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function addLine() {
    setLineError(null);
    if (!variant) {
      setLineError("محصول و variant را انتخاب کنید.");
      return;
    }
    const qty = parseDecimalInput(quantity);
    if (!qty || Number(qty) <= 0) {
      setLineError("تعداد باید عددی مثبت باشد.");
      return;
    }
    setLines((current) => [
      ...current,
      {
        key: `${Date.now()}-${current.length}`,
        variant,
        quantity: qty,
        unitPrice: parseDecimalInput(unitPrice) || "0",
      },
    ]);
    setVariant(null);
    setQuantity("");
    setUnitPrice("");
  }

  function removeLine(key: string) {
    setLines((current) => current.filter((line) => line.key !== key));
  }

  async function handleSubmit() {
    setError(null);
    if (!supplier) {
      setError("انتخاب تامین‌کننده الزامی است (نقش تامین‌کننده).");
      return;
    }
    if (lines.length === 0) {
      setError("حداقل یک خط به سند اضافه کنید.");
      return;
    }
    setSaving(true);
    try {
      const created = await createPurchase({
        supplierPartyId: supplier.id,
        buyerUserId: buyer?.id,
        documentDate: documentDate ?? undefined,
        paymentTermId: paymentTermId || undefined,
        lines: lines.map((line) => ({
          productVariantId: line.variant.variantId,
          quantity: Number(line.quantity),
          unitPrice: Number(line.unitPrice) || 0,
        })),
      });
      router.push(`/purchases/${created.id}`);
    } catch (err) {
      setError(purchaseErrorMessage(err));
      setSaving(false);
    }
  }

  return (
    <div
      className="space-y-5"
      onKeyDown={(event) => {
        if (event.key === "Enter" && event.ctrlKey) void handleSubmit();
        if (event.key === "s" && event.ctrlKey) {
          event.preventDefault();
          void handleSubmit();
        }
      }}
    >
      <div>
        <h2 className="text-lg font-bold text-slate-800">سند خرید جدید</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          تامین‌کننده باید نقش تامین‌کننده داشته باشد؛ قیمت‌ها را خریدار وارد می‌کند.
        </p>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="سربرگ سند خرید">
        <h3 className="text-sm font-bold text-slate-800">سربرگ سند</h3>
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              تامین‌کننده <span className="text-red-500">*</span>
            </label>
            <EntitySelector
              endpoint={(q) => `/parties?role=SUPPLIER&search=${encodeURIComponent(q)}&pageSize=10`}
              mapItem={partyMapItem}
              value={supplier}
              onChange={setSupplier}
              placeholder="جستجوی تامین‌کننده…"
              ariaLabel="انتخاب تامین‌کننده"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">خریدار</label>
            <EntitySelector
              endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
              mapItem={userMapItem}
              value={buyer}
              onChange={setBuyer}
              placeholder="خودم (پیش‌فرض)"
              ariaLabel="انتخاب خریدار"
              emptySearchLabel="برای جستجوی خریدار تایپ کنید"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">تاریخ سند</label>
            <JalaliDateInput value={documentDate} onChange={setDocumentDate} ariaLabel="تاریخ سند خرید" />
          </div>
          <div>
            <label htmlFor="purchase-term" className="mb-1 block text-xs font-medium text-slate-600">
              شرایط پرداخت
            </label>
            <select
              id="purchase-term"
              value={paymentTermId}
              onChange={(event) => setPaymentTermId(event.target.value)}
              aria-label="انتخاب شرایط پرداخت"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">—</option>
              {paymentTerms.map((term) => (
                <option key={term.id} value={term.id}>
                  {term.nameFa}
                  {term.daysOffset !== null ? ` (${faDigits(term.daysOffset)} روز)` : ""}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="خطوط سند خرید">
        <h3 className="text-sm font-bold text-slate-800">خطوط سند</h3>
        {lineError && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {lineError}
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 items-end gap-3 md:grid-cols-2 xl:grid-cols-5">
          <div className="xl:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-600">محصول / variant *</label>
            <VariantSelector value={variant} onChange={setVariant} />
          </div>
          <div>
            <label htmlFor="p-line-qty" className="mb-1 block text-xs font-medium text-slate-600">
              تعداد *
            </label>
            <Input
              id="p-line-qty"
              dir="ltr"
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLine();
                }
              }}
              aria-label="تعداد خط خرید"
            />
          </div>
          <div>
            <label htmlFor="p-line-price" className="mb-1 block text-xs font-medium text-slate-600">
              قیمت واحد (ریال)
            </label>
            <Input
              id="p-line-price"
              dir="ltr"
              inputMode="decimal"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addLine();
                }
              }}
              aria-label="قیمت واحد خط خرید"
            />
          </div>
          <div className="flex items-center">
            <Button onClick={addLine} className="w-full">
              افزودن خط
            </Button>
          </div>
        </div>

        {lines.length === 0 ? (
          <p className="mt-4 text-xs text-slate-400">هنوز خطی اضافه نشده است.</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm" aria-label="خطوط پیش‌نویس">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-500">
                  <th scope="col" className="px-3 py-2 text-start">محصول</th>
                  <th scope="col" className="px-3 py-2 text-center">تعداد</th>
                  <th scope="col" className="px-3 py-2 text-end">قیمت واحد</th>
                  <th scope="col" className="px-3 py-2 text-end">جمع</th>
                  <th scope="col" className="px-3 py-2 text-center">حذف</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {lines.map((line) => (
                  <tr key={line.key} className="text-slate-700">
                    <td className="px-3 py-1.5">{line.variant.label}</td>
                    <td className="px-3 py-1.5 text-center tabular-nums">{faDigits(line.quantity)}</td>
                    <td className="px-3 py-1.5 text-end tabular-nums">
                      {faDigits(thousandSeparate(Number(line.unitPrice) || 0))}
                    </td>
                    <td className="px-3 py-1.5 text-end tabular-nums">
                      {faDigits(thousandSeparate(Number(line.quantity) * (Number(line.unitPrice) || 0)))}
                    </td>
                    <td className="px-3 py-1.5 text-center">
                      <button
                        type="button"
                        onClick={() => removeLine(line.key)}
                        className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
          <Button onClick={() => void handleSubmit()} disabled={saving}>
            {saving ? "در حال ثبت…" : "ثبت سند خرید (Ctrl+S)"}
          </Button>
          <span className="text-xs text-slate-400">
            با Enter در فیلدهای خط، ردیف اضافه می‌شود؛ Ctrl+S سند را ثبت می‌کند.
          </span>
        </div>
      </section>
    </div>
  );
}
