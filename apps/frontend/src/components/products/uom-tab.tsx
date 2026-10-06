"use client";

import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { faDigits, faMoney } from "@/lib/format";
import {
  convertUom,
  productErrorMessage,
  type TemplateDetail,
} from "@/lib/product";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

const selectClass =
  "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20";

export function UomTab({ template }: { template: TemplateDetail }) {
  const [value, setValue] = useState("");
  const [direction, setDirection] = useState<"sales-to-purchase" | "purchase-to-sales">(
    "sales-to-purchase",
  );
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  const salesUom = template.salesUom;
  const purchaseUom = template.purchaseUom;

  async function handleConvert(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setResult(null);
    if (!salesUom || !purchaseUom) return;
    const normalized = value
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
      .replace(/[,،\s]/g, "")
      .trim();
    if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) {
      setError("یک مقدار عددی وارد کنید.");
      return;
    }
    setConverting(true);
    try {
      const response = await convertUom({
        value: normalized,
        fromUomId: direction === "sales-to-purchase" ? salesUom.id : purchaseUom.id,
        toUomId: direction === "sales-to-purchase" ? purchaseUom.id : salesUom.id,
      });
      setResult(`${faDigits(Number(response.value))} ${response.toSymbol}`);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setConverting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="mb-4 text-sm font-bold text-slate-800">واحدهای این محصول</h3>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-[11px] text-slate-400">واحد فروش</dt>
            <dd className="mt-0.5 text-sm text-slate-800">
              {salesUom ? `${salesUom.nameFa} (${salesUom.symbol})` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-400">واحد خرید</dt>
            <dd className="mt-0.5 text-sm text-slate-800">
              {purchaseUom ? `${purchaseUom.nameFa} (${purchaseUom.symbol})` : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[11px] text-slate-400">قیمت پیش‌فرض فروش</dt>
            <dd className="mt-0.5 text-sm text-slate-800">
              {template.defaultSalesPrice ? faMoney(Number(template.defaultSalesPrice)) : "—"}
            </dd>
          </div>
        </dl>
      </div>

      <form
        onSubmit={handleConvert}
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="تبدیل سریع واحدهای محصول"
      >
        <h3 className="mb-4 text-sm font-bold text-slate-800">تبدیل سریع</h3>
        {!salesUom || !purchaseUom ? (
          <p className="text-xs text-amber-700">
            برای تبدیل، هر دو واحد فروش و خرید باید در تب «عمومی» تعیین شده باشند.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="tu-value" className={fieldLabel}>مقدار</label>
                <Input
                  id="tu-value"
                  dir="ltr"
                  inputMode="decimal"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              </div>
              <div>
                <label htmlFor="tu-direction" className={fieldLabel}>جهت تبدیل</label>
                <select
                  id="tu-direction"
                  value={direction}
                  onChange={(event) => setDirection(event.target.value as typeof direction)}
                  className={selectClass}
                >
                  <option value="sales-to-purchase">
                    واحد فروش → واحد خرید
                  </option>
                  <option value="purchase-to-sales">
                    واحد خرید → واحد فروش
                  </option>
                </select>
              </div>
              <div>
                <Button type="submit" disabled={converting}>
                  {converting ? "در حال تبدیل…" : "تبدیل"}
                </Button>
              </div>
            </div>
            {result && (
              <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800" role="status">
                نتیجه: {result}
              </p>
            )}
            {error && (
              <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </form>
    </div>
  );
}
