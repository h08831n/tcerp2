"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { RelatedDocumentsCard } from "@/components/documents/related-documents";
import { PurchaseStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali, toNum, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import {
  purchaseErrorMessage,
  addPurchaseLine,
  cancelPurchase,
  completePurchase,
  receivePurchase,
  deletePurchaseLine,
  fetchPurchase,
  placePurchase,
  updatePurchaseLine,
  type PurchaseDocumentDetail,
  type PurchaseLineDto,
} from "@/lib/purchase";

const CLOSED_STATUSES = ["COMPLETED", "CANCELLED"];

export default function PurchaseDocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [doc, setDoc] = useState<PurchaseDocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receiveNote, setReceiveNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // New line editor.
  const [variant, setVariant] = useState<VariantSelection | null>(null);
  const [quantity, setQuantity] = useState("");
  const [unitPrice, setUnitPrice] = useState("");

  // Inline line edit.
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState({ quantity: "", unitPrice: "" });

  const [cancelOpen, setCancelOpen] = useState(false);
  const [lineSaveRef, setLineSaveRef] = useState<(() => Promise<void>) | null>(null);

  const reload = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      setDoc(await fetchPurchase(id));
    } catch (err) {
      setLoadError(purchaseErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const closed = doc ? CLOSED_STATUSES.includes(doc.status) : false;

  function handleActionError(err: unknown) {
    setActionError(purchaseErrorMessage(err));
  }

  async function runTransition(action: "place" | "complete") {
    if (!doc) return;
    setBusy(action);
    setActionError(null);
    try {
      const updated =
        action === "place" ? await placePurchase(doc.id) : await completePurchase(doc.id);
      setDoc(updated);
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleReceive() {
    if (!doc) return;
    setBusy("receive");
    setActionError(null);
    try {
      const res = await receivePurchase(doc.id);
      setReceiveNote(res.moved === false ? "قبلاً دریافت شده — گردش جدیدی ثبت نشد." : "دریافت به انبار ثبت شد (گردش ورود).");
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleCancel() {
    if (!doc) return;
    setBusy("cancel");
    setActionError(null);
    try {
      setDoc(await cancelPurchase(doc.id));
      setCancelOpen(false);
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleAddLine() {
    if (!doc) return;
    setActionError(null);
    if (!variant) {
      setActionError("محصول و variant را انتخاب کنید.");
      return;
    }
    const qty = parseDecimalInput(quantity);
    if (!qty || Number(qty) <= 0) {
      setActionError("تعداد باید عددی مثبت باشد.");
      return;
    }
    const price = parseDecimalInput(unitPrice);
    setBusy("addLine");
    try {
      setDoc(
        await addPurchaseLine(doc.id, {
          productVariantId: variant.variantId,
          quantity: Number(qty),
          ...(price ? { unitPrice: Number(price) } : {}),
        }),
      );
      setVariant(null);
      setQuantity("");
      setUnitPrice("");
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  function beginLineEdit(line: PurchaseLineDto) {
    setEditingLineId(line.id);
    setActionError(null);
    setLineDraft({
      quantity: String(toNum(line.orderedQuantity) ?? ""),
      unitPrice: String(toNum(line.unitPrice) ?? ""),
    });
  }

  const saveLine = useCallback(
    async (line: PurchaseLineDto) => {
      if (!doc) return;
      const qty = parseDecimalInput(lineDraft.quantity);
      if (!qty || Number(qty) <= 0) {
        setActionError("تعداد باید عددی مثبت باشد.");
        return;
      }
      const price = parseDecimalInput(lineDraft.unitPrice);
      setBusy(`line:${line.id}`);
      setActionError(null);
      try {
        setDoc(
          await updatePurchaseLine(doc.id, line.id, {
            quantity: Number(qty),
            ...(price ? { unitPrice: Number(price) } : { unitPrice: 0 }),
          }),
        );
        setEditingLineId(null);
      } catch (err) {
        handleActionError(err);
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, lineDraft],
  );

  // Keep the current save callable reachable from the global Ctrl+S handler.
  const currentEditingLine = useMemo(
    () => doc?.lines.find((line) => line.id === editingLineId) ?? null,
    [doc, editingLineId],
  );
  useEffect(() => {
    setLineSaveRef(currentEditingLine ? () => saveLine(currentEditingLine) : null);
  }, [currentEditingLine, saveLine]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (lineSaveRef) void lineSaveRef();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [lineSaveRef]);

  async function removeLine(line: PurchaseLineDto) {
    if (!doc) return;
    setBusy(`line:${line.id}`);
    setActionError(null);
    try {
      setDoc(await deletePurchaseLine(doc.id, line.id));
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  if (loading && !doc) {
    return (
      <div className="flex min-h-40 items-center justify-center">
        <span className="text-sm text-slate-400">در حال بارگذاری سند…</span>
      </div>
    );
  }

  if (loadError && !doc) {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
        {loadError}{" "}
        <button type="button" className="font-bold underline" onClick={() => void reload()}>
          تلاش مجدد
        </button>
      </div>
    );
  }

  if (!doc) return null;

  const total = toNum(doc.total);

  return (
    <div className="space-y-4">
      {receiveNote && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">
          {receiveNote}
        </div>
      )}
      {actionError && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          role="alert"
        >
          <span>{actionError}</span>
          <button type="button" className="text-xs font-bold underline" onClick={() => setActionError(null)}>
            بستن
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <section
          className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm xl:col-span-2"
          aria-label="سربرگ سند خرید"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 dir="ltr" className="text-lg font-bold text-primary-700">
                  {doc.documentNumber}
                </h2>
                <PurchaseStatusBadge status={doc.status} />
              </div>
              <p className="mt-1 text-xs text-slate-500">
                تامین‌کننده:{" "}
                <span className="font-medium text-slate-700">{doc.supplier?.nameFa ?? "—"}</span>
                <span className="mx-2 text-slate-300">|</span>
                خریدار: <span className="font-medium text-slate-700">{doc.buyer?.username ?? "—"}</span>
              </p>
            </div>

            {/* Transitions */}
            <div className="flex flex-wrap items-center gap-2">
              {doc.status === "DRAFT" && (
                <Button size="sm" onClick={() => void runTransition("place")} disabled={busy !== null}>
                  {busy === "place" ? "در حال ثبت…" : "ثبت سفارش"}
                </Button>
              )}
              {(doc.status === "ORDER_PLACED" || doc.status === "PARTIALLY_LOADED") && (
                <Button
                  size="sm"
                  onClick={() => void runTransition("complete")}
                  disabled={busy !== null}
                >
                  {busy === "complete" ? "در حال تکمیل…" : "تکمیل"}
                </Button>
              )}
              {doc.status === "ORDER_PLACED" && (
                <Button size="sm" variant="secondary" onClick={() => void handleReceive()} disabled={busy !== null}>
                  {busy === "receive" ? "در حال دریافت…" : "دریافت به انبار"}
                </Button>
              )}
              {!CLOSED_STATUSES.includes(doc.status) && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setCancelOpen(true)}
                  disabled={busy !== null}
                >
                  لغو
                </Button>
              )}
            </div>
          </div>

          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
            <div>
              <dt className="text-xs text-slate-500">تاریخ سند</dt>
              <dd className="tabular-nums text-slate-800">{jalali(doc.documentDate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">شرایط پرداخت</dt>
              <dd className="text-slate-800">{doc.paymentTerm?.nameFa ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">استعلام مرجع</dt>
              <dd className="text-slate-800">{doc.priceRequest?.requestNumber ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">مبلغ بارگیری‌شده</dt>
              <dd className="tabular-nums text-slate-700">
                {doc.operationalLoadedAmount !== null && doc.operationalLoadedAmount !== undefined
                  ? `${faDigits(thousandSeparate(toNum(doc.operationalLoadedAmount) ?? 0))} ریال`
                  : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-slate-600">مبلغ کل</dt>
              <dd className="font-bold tabular-nums text-primary-700">
                {total !== null ? `${faDigits(thousandSeparate(total))} ریال` : "—"}
              </dd>
            </div>
          </dl>
        </section>

        <RelatedDocumentsCard entityType="purchase_document" entityId={doc.id} />
      </div>

      {/* Lines */}
      <section
        className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        aria-label="خطوط سند خرید"
      >
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">خطوط سند — {faDigits(doc.lines.length)} ردیف</h3>
        </div>

        {/* Add line (open documents only) */}
        {!closed && (
          <div className="grid grid-cols-1 items-end gap-3 border-b border-slate-100 px-4 py-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="xl:col-span-2">
              <label className="mb-1 block text-xs font-medium text-slate-600">محصول / variant *</label>
              <VariantSelector value={variant} onChange={setVariant} />
            </div>
            <div>
              <label htmlFor="pd-qty" className="mb-1 block text-xs font-medium text-slate-600">
                تعداد *
              </label>
              <Input
                id="pd-qty"
                inputSize="sm"
                dir="ltr"
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleAddLine();
                }}
                aria-label="تعداد خط جدید"
              />
            </div>
            <div>
              <label htmlFor="pd-price" className="mb-1 block text-xs font-medium text-slate-600">
                قیمت واحد (ریال)
              </label>
              <Input
                id="pd-price"
                inputSize="sm"
                dir="ltr"
                inputMode="decimal"
                value={unitPrice}
                onChange={(event) => setUnitPrice(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void handleAddLine();
                }}
                aria-label="قیمت واحد خط جدید"
              />
            </div>
            <div>
              <Button size="sm" onClick={() => void handleAddLine()} disabled={busy === "addLine"}>
                {busy === "addLine" ? "در حال افزودن…" : "افزودن خط"}
              </Button>
            </div>
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="جدول خطوط سند خرید">
            <thead>
              <tr className="bg-white text-xs text-slate-500">
                <th scope="col" className="px-3 py-2 text-start">محصول</th>
                <th scope="col" className="px-3 py-2 text-center">تعداد</th>
                <th scope="col" className="px-3 py-2 text-end">قیمت واحد</th>
                <th scope="col" className="px-3 py-2 text-end">جمع خط</th>
                <th scope="col" className="px-3 py-2 text-center">ویرایش</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {doc.lines.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-slate-400">
                    خطی ثبت نشده است.
                  </td>
                </tr>
              ) : (
                doc.lines.map((line) =>
                  editingLineId === line.id ? (
                    <tr key={line.id} className="bg-primary-50/40">
                      <td className="px-3 py-2 text-slate-700">{line.productVariant.nameFa}</td>
                      <td className="px-3 py-2 text-center">
                        <Input
                          inputSize="sm"
                          dir="ltr"
                          inputMode="decimal"
                          className="w-20 text-center"
                          value={lineDraft.quantity}
                          onChange={(event) =>
                            setLineDraft((draft) => ({ ...draft, quantity: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveLine(line);
                            if (event.key === "Escape") setEditingLineId(null);
                          }}
                          aria-label="تعداد"
                        />
                      </td>
                      <td className="px-3 py-2 text-end">
                        <Input
                          inputSize="sm"
                          dir="ltr"
                          inputMode="decimal"
                          className="w-28 text-end"
                          value={lineDraft.unitPrice}
                          onChange={(event) =>
                            setLineDraft((draft) => ({ ...draft, unitPrice: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveLine(line);
                            if (event.key === "Escape") setEditingLineId(null);
                          }}
                          aria-label="قیمت واحد"
                        />
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-slate-400">
                        {faDigits(thousandSeparate(toNum(line.lineTotal) ?? 0))}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            size="sm"
                            onClick={() => void saveLine(line)}
                            disabled={busy === `line:${line.id}`}
                          >
                            ذخیره
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setEditingLineId(null)}>
                            انصراف
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={line.id} className="text-slate-700 hover:bg-slate-50">
                      <td className="px-3 py-2">
                        {line.productVariant.nameFa}
                        <span dir="ltr" className="block text-[10px] text-slate-400">
                          {line.productVariant.sku}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-center tabular-nums">
                        {faDigits(toNum(line.orderedQuantity) ?? 0)}
                        <span className="ms-1 text-[10px] text-slate-400">{line.uom?.symbol}</span>
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">
                        {faDigits(thousandSeparate(toNum(line.unitPrice) ?? 0))}
                      </td>
                      <td className="px-3 py-2 text-end font-medium tabular-nums">
                        {faDigits(thousandSeparate(toNum(line.lineTotal) ?? 0))}
                      </td>
                      <td className="px-3 py-2">
                        {!closed ? (
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => beginLineEdit(line)}
                              className="rounded px-1.5 py-0.5 text-xs font-medium text-primary-600 hover:bg-primary-50"
                            >
                              ویرایش
                            </button>
                            <button
                              type="button"
                              onClick={() => void removeLine(line)}
                              className="rounded px-1.5 py-0.5 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              حذف
                            </button>
                          </div>
                        ) : (
                          <span className="text-xs text-slate-300">بسته</span>
                        )}
                      </td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
      </section>

      <Modal
        open={cancelOpen}
        title="لغو سند خرید"
        onClose={() => setCancelOpen(false)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCancelOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void handleCancel()}
              disabled={busy === "cancel"}
            >
              {busy === "cancel" ? "در حال لغو…" : "لغو سند"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-600">
          آیا از لغو سند <span dir="ltr" className="font-bold">{doc.documentNumber}</span> مطمئن هستید؟
        </p>
      </Modal>

      <p className="text-xs text-slate-400">
        <Link href="/purchases" className="text-primary-600 underline">
          بازگشت به فهرست خرید
        </Link>
      </p>
    </div>
  );
}
