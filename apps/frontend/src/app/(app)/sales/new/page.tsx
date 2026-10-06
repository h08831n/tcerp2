"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { MatrixEntry, type MatrixEntryCell } from "@/components/sales/matrix-entry";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { SaleStatusBadge } from "@/components/documents/status-badges";
import { faDigits, toNum, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import {
  addSaleLine,
  addSaleLinesFromMatrix,
  createSale,
  salesErrorMessage,
  type SalesDocumentDetail,
} from "@/lib/sales";
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

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function NewSalePage() {
  const router = useRouter();

  // ── step 1: header ──
  const [customer, setCustomer] = useState<EntityOption | null>(null);
  const [salesperson, setSalesperson] = useState<EntityOption | null>(null);
  const [documentDate, setDocumentDate] = useState<string | null>(todayIso());
  const [expirationDate, setExpirationDate] = useState<string | null>(null);
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermDto[]>([]);
  const [paymentTermId, setPaymentTermId] = useState("");
  const [creating, setCreating] = useState(false);
  const [headerError, setHeaderError] = useState<string | null>(null);

  // ── step 2: lines ──
  const [doc, setDoc] = useState<SalesDocumentDetail | null>(null);
  const [mode, setMode] = useState<"matrix" | "single">("matrix");
  const [submitting, setSubmitting] = useState(false);
  const [linesError, setLinesError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  // single-line editor
  const [variant, setVariant] = useState<VariantSelection | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");
  const [discount, setDiscount] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchPaymentTerms(true)
      .then((terms) => {
        if (!cancelled) setPaymentTerms(terms);
      })
      .catch(() => {
        /* payment term is optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const expirationHint = expirationDate
    ? null
    : "خالی = تاریخ سند + ۱۴ روز (تنظیم پیش‌فرض شرکت)";

  async function handleCreateDraft() {
    setHeaderError(null);
    if (!customer) {
      setHeaderError("انتخاب مشتری الزامی است.");
      return;
    }
    setCreating(true);
    try {
      const created = await createSale({
        customerPartyId: customer.id,
        salespersonUserId: salesperson?.id,
        documentDate: documentDate ?? undefined,
        expirationDate: expirationDate ?? undefined,
        paymentTermId: paymentTermId || undefined,
        status: "DRAFT",
        lines: [],
      });
      setDoc(created);
    } catch (err) {
      setHeaderError(salesErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function submitMatrixCells(cells: MatrixEntryCell[]) {
    if (!doc) return;
    setSubmitting(true);
    setLinesError(null);
    try {
      const updated = await addSaleLinesFromMatrix(
        doc.id,
        cells.map((cell) => ({ productVariantId: cell.productVariantId, quantity: cell.quantity })),
      );
      setDoc(updated);
      setSavedNotice("خطوط ماتریس ثبت شد.");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAddSingleLine() {
    if (!doc) return;
    setLinesError(null);
    if (!variant) {
      setLinesError("محصول و variant را انتخاب کنید.");
      return;
    }
    const qty = parseDecimalInput(quantity);
    if (!qty || Number(qty) <= 0) {
      setLinesError("تعداد باید عددی مثبت باشد.");
      return;
    }
    const price = parseDecimalInput(unitPrice);
    const disc = parseDecimalInput(discount);
    setSubmitting(true);
    try {
      const updated = await addSaleLine(doc.id, {
        productVariantId: variant.variantId,
        quantity: Number(qty),
        ...(price ? { unitPrice: Number(price) } : {}),
        ...(disc ? { discountAmount: Number(disc) } : {}),
      });
      setDoc(updated);
      setVariant(null);
      setQuantity("");
      setUnitPrice("");
      setDiscount("");
      setSavedNotice("خط اضافه شد.");
    } catch (err) {
      setLinesError(salesErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  const totalValue = doc ? toNum(doc.total) : null;

  return (
    <div
      className="space-y-5"
      onKeyDown={(event) => {
        // Ctrl+Enter creates the draft while the header form is active.
        if (!doc && event.key === "Enter" && event.ctrlKey) {
          event.preventDefault();
          void handleCreateDraft();
        }
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">پیش‌فاکتور جدید</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            ابتدا اطلاعات سربرگ سند ثبت و پیش‌نویس ایجاد می‌شود؛ سپس خطوط (ماتریس یا تک) اضافه کنید.
          </p>
        </div>
        {doc && (
          <div className="flex items-center gap-2">
            <SaleStatusBadge status={doc.status} />
            <span dir="ltr" className="text-sm font-bold text-primary-700">
              {doc.documentNumber}
            </span>
          </div>
        )}
      </div>

      {/* Step 1 — header */}
      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="سربرگ سند">
        <h3 className="text-sm font-bold text-slate-800">سربرگ سند</h3>
        {headerError && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {headerError}
          </div>
        )}
        <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              مشتری <span className="text-red-500">*</span>
            </label>
            <EntitySelector
              endpoint={(q) => `/parties?role=CUSTOMER&search=${encodeURIComponent(q)}&pageSize=10`}
              mapItem={partyMapItem}
              value={customer}
              onChange={setCustomer}
              placeholder="جستجوی مشتری…"
              ariaLabel="انتخاب مشتری"
              disabled={Boolean(doc)}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">فروشنده</label>
            <EntitySelector
              endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
              mapItem={userMapItem}
              value={salesperson}
              onChange={setSalesperson}
              placeholder="خودم (پیش‌فرض)"
              ariaLabel="انتخاب فروشنده"
              disabled={Boolean(doc)}
              emptySearchLabel="برای جستجوی فروشنده تایپ کنید"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">شرایط پرداخت</label>
            <select
              value={paymentTermId}
              onChange={(event) => setPaymentTermId(event.target.value)}
              disabled={Boolean(doc)}
              aria-label="انتخاب شرایط پرداخت"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:cursor-not-allowed disabled:bg-slate-50"
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
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">تاریخ سند</label>
            <JalaliDateInput
              value={documentDate}
              onChange={setDocumentDate}
              disabled={Boolean(doc)}
              ariaLabel="تاریخ سند (شمسی)"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">تاریخ انقضا</label>
            <JalaliDateInput
              value={expirationDate}
              onChange={setExpirationDate}
              disabled={Boolean(doc)}
              ariaLabel="تاریخ انقضا (شمسی)"
            />
            {expirationHint && (
              <p className="mt-1 text-[11px] text-slate-400">{expirationHint}</p>
            )}
          </div>
        </div>
        {!doc && (
          <div className="mt-4 flex items-center gap-3">
            <Button onClick={() => void handleCreateDraft()} disabled={creating}>
              {creating ? "در حال ایجاد…" : "ایجاد پیش‌نویس سند (Ctrl+Enter)"}
            </Button>
            {!customer && <span className="text-xs text-slate-400">ابتدا مشتری را انتخاب کنید.</span>}
          </div>
        )}
      </section>

      {/* Step 2 — lines */}
      {doc && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm" aria-label="خطوط سند">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-800">افزودن خطوط</h3>
            <div className="flex overflow-hidden rounded-md border border-slate-300" role="tablist" aria-label="روش افزودن خط">
              <button
                type="button"
                role="tab"
                aria-selected={mode === "matrix"}
                onClick={() => setMode("matrix")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "matrix" ? "bg-primary-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                ورود ماتریسی
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mode === "single"}
                onClick={() => setMode("single")}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === "single" ? "bg-primary-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
                }`}
              >
                افزودن خط (تک)
              </button>
            </div>
          </div>

          {savedNotice && (
            <p role="status" className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
              {savedNotice}
            </p>
          )}
          {linesError && (
            <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {linesError}
            </div>
          )}

          {mode === "matrix" ? (
            <div className="mt-4">
              <MatrixEntry onSubmit={submitMatrixCells} submitting={submitting} />
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-1 items-end gap-3 md:grid-cols-2 xl:grid-cols-5">
              <div className="xl:col-span-2">
                <label className="mb-1 block text-xs font-medium text-slate-600">محصول / variant *</label>
                <VariantSelector value={variant} onChange={setVariant} />
              </div>
              <div>
                <label htmlFor="line-qty" className="mb-1 block text-xs font-medium text-slate-600">
                  تعداد *
                </label>
                <Input
                  id="line-qty"
                  dir="ltr"
                  inputMode="decimal"
                  value={quantity}
                  onChange={(event) => setQuantity(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleAddSingleLine();
                    }
                  }}
                  aria-label="تعداد خط"
                />
              </div>
              <div>
                <label htmlFor="line-price" className="mb-1 block text-xs font-medium text-slate-600">
                  قیمت واحد (ریال)
                </label>
                <Input
                  id="line-price"
                  dir="ltr"
                  inputMode="decimal"
                  value={unitPrice}
                  onChange={(event) => setUnitPrice(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleAddSingleLine();
                    }
                  }}
                  aria-label="قیمت واحد خط"
                />
              </div>
              <div>
                <label htmlFor="line-discount" className="mb-1 block text-xs font-medium text-slate-600">
                  تخفیف (ریال)
                </label>
                <div className="flex gap-2">
                  <Input
                    id="line-discount"
                    dir="ltr"
                    inputMode="decimal"
                    value={discount}
                    onChange={(event) => setDiscount(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void handleAddSingleLine();
                      }
                    }}
                    aria-label="تخفیف خط"
                  />
                  <Button onClick={() => void handleAddSingleLine()} disabled={submitting}>
                    افزودن
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Current lines + totals */}
          <div className="mt-5 border-t border-slate-100 pt-4">
            {doc.lines.length === 0 ? (
              <p className="text-xs text-slate-400">هنوز خطی ثبت نشده است.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-sm" aria-label="خطوط ثبت‌شده">
                  <thead>
                    <tr className="bg-slate-50 text-xs text-slate-500">
                      <th scope="col" className="px-3 py-2 text-start">شرح چاپی</th>
                      <th scope="col" className="px-3 py-2 text-center">تعداد</th>
                      <th scope="col" className="px-3 py-2 text-end">قیمت واحد</th>
                      <th scope="col" className="px-3 py-2 text-end">جمع خط</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {doc.lines.map((line) => (
                      <tr key={line.id} className="text-slate-700">
                        <td className="px-3 py-1.5">{line.printableDescription ?? line.productVariant.nameFa}</td>
                        <td className="px-3 py-1.5 text-center tabular-nums">
                          {faDigits(toNum(line.orderedQuantity) ?? 0)}
                          <span className="ms-1 text-[10px] text-slate-400">{line.uom.symbol}</span>
                        </td>
                        <td className="px-3 py-1.5 text-end tabular-nums">
                          {faDigits(thousandSeparate(toNum(line.unitPrice) ?? 0))}
                        </td>
                        <td className="px-3 py-1.5 text-end tabular-nums">
                          {faDigits(thousandSeparate(toNum(line.lineTotal) ?? 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm font-bold text-slate-800">
                مبلغ کل:{" "}
                <span className="tabular-nums">
                  {totalValue !== null ? `${faDigits(thousandSeparate(totalValue))} ریال` : "—"}
                </span>
              </p>
              <Button onClick={() => router.push(`/sales/${doc.id}`)}>
                رفتن به صفحه سند
              </Button>
            </div>
          </div>
        </section>
      )}

      <p className="text-xs text-slate-400">
        می‌توانید بعداً از فهرست فروش هم به این سند برگردید.{" "}
        <Link href="/sales" className="text-primary-600 underline">
          بازگشت به فهرست فروش
        </Link>
      </p>
    </div>
  );
}
