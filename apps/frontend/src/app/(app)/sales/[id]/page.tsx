"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { RelatedDocumentsCard } from "@/components/documents/related-documents";
import { SaleStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali, toNum, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import {
  fetchLostReasons,
  fetchPaymentTerms,
  type LostReasonDto,
  type PaymentTermDto,
} from "@/lib/crm";
import {
  isSalesLocked,
  salesErrorMessage,
  activateSale,
  addSaleLine,
  cancelSale,
  confirmSale,
  deleteSaleLine,
  fetchSale,
  loseSale,
  sendSale,
  updateSale,
  updateSaleLine,
  type SalesDocumentDetail,
  type SalesLineDto,
} from "@/lib/sales";

export default function SalesDocumentDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";

  const [doc, setDoc] = useState<SalesDocumentDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  // Header edit (expiration + payment term stay editable on confirmed orders).
  const [editHeader, setEditHeader] = useState(false);
  const [expirationDate, setExpirationDate] = useState<string | null>(null);
  const [paymentTermId, setPaymentTermId] = useState("");
  const [paymentTerms, setPaymentTerms] = useState<PaymentTermDto[]>([]);

  // Line edit (inline row editor).
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState({
    quantity: "",
    unitPrice: "",
    discount: "",
    printableDescription: "",
  });

  // New line editor (add line to this document).
  const [newVariant, setNewVariant] = useState<VariantSelection | null>(null);
  const [newQuantity, setNewQuantity] = useState("");
  const [newUnitPrice, setNewUnitPrice] = useState("");
  const [newDiscount, setNewDiscount] = useState("");

  // Manager override.
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [overrideReason, setOverrideReason] = useState("");
  const [overrideActive, setOverrideActive] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  // Lost modal.
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReasons, setLostReasons] = useState<LostReasonDto[]>([]);
  const [lostReasonId, setLostReasonId] = useState("");
  const [lostNotes, setLostNotes] = useState("");

  // Cancel confirm.
  const [cancelOpen, setCancelOpen] = useState(false);

  const reload = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setLoadError(null);
    try {
      const result = await fetchSale(id);
      setDoc(result);
      setVersionConflict(false);
      setOverrideActive(false);
      setEditingLineId(null);
      setEditHeader(false);
    } catch (err) {
      setLoadError(salesErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void reload();
  }, [reload]);

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

  useEffect(() => {
    if (!lostOpen || lostReasons.length > 0) return;
    let cancelled = false;
    fetchLostReasons(true)
      .then((reasons) => {
        if (!cancelled) setLostReasons(reasons);
      })
      .catch(() => {
        /* list stays empty; backend rejects with LOST_REASON_REQUIRED */
      });
    return () => {
      cancelled = true;
    };
  }, [lostOpen, lostReasons.length]);

  const locked = doc ? isSalesLocked(doc.status) : false;

  function handleActionError(err: unknown) {
    setActionError(salesErrorMessage(err));
    if (err instanceof Error && err.message === "VERSION_CONFLICT") setVersionConflict(true);
  }

  async function runTransition(action: "send" | "confirm" | "activate") {
    if (!doc) return;
    setBusy(action);
    setActionError(null);
    try {
      const updated =
        action === "send"
          ? await sendSale(doc.id)
          : action === "confirm"
            ? await confirmSale(doc.id)
            : await activateSale(doc.id);
      setDoc(updated);
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  async function handleLost() {
    if (!doc) return;
    if (!lostReasonId) {
      setActionError("انتخاب دلیل باخت الزامی است.");
      return;
    }
    setBusy("lost");
    setActionError(null);
    try {
      const updated = await loseSale(doc.id, {
        lostReasonId,
        ...(lostNotes.trim() ? { notes: lostNotes.trim() } : {}),
      });
      setDoc(updated);
      setLostOpen(false);
      setLostReasonId("");
      setLostNotes("");
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
      const updated = await cancelSale(doc.id);
      setDoc(updated);
      setCancelOpen(false);
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  function beginHeaderEdit() {
    if (!doc) return;
    setExpirationDate(doc.expirationDate ? doc.expirationDate.slice(0, 10) : null);
    setPaymentTermId(doc.paymentTerm?.id ?? "");
    setEditHeader(true);
    setActionError(null);
  }

  const saveHeader = useCallback(async () => {
    if (!doc) return;
    setBusy("header");
    setActionError(null);
    try {
      const updated = await updateSale(doc.id, {
        expirationDate: expirationDate ?? undefined,
        paymentTermId: paymentTermId || null,
        version: doc.version,
      });
      setDoc(updated);
      setEditHeader(false);
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, expirationDate, paymentTermId]);

  function beginLineEdit(line: SalesLineDto) {
    setEditingLineId(line.id);
    setActionError(null);
    setLineDraft({
      quantity: String(toNum(line.orderedQuantity) ?? ""),
      unitPrice: String(toNum(line.unitPrice) ?? ""),
      discount: String(toNum(line.discountAmount) ?? ""),
      printableDescription: line.printableDescription ?? "",
    });
  }

  const saveLine = useCallback(
    async (line: SalesLineDto) => {
      if (!doc) return;
      const qty = parseDecimalInput(lineDraft.quantity);
      if (!qty || Number(qty) <= 0) {
        setActionError("تعداد باید عددی مثبت باشد.");
        return;
      }
      const price = parseDecimalInput(lineDraft.unitPrice);
      const discount = parseDecimalInput(lineDraft.discount);
      setBusy(`line:${line.id}`);
      setActionError(null);
      try {
        const updated = await updateSaleLine(doc.id, line.id, {
          quantity: Number(qty),
          ...(price ? { unitPrice: Number(price) } : {}),
          ...(discount ? { discountAmount: Number(discount) } : { discountAmount: 0 }),
          printableDescription: lineDraft.printableDescription,
          ...(overrideActive ? { overrideReason } : {}),
        });
        setDoc(updated);
        setEditingLineId(null);
      } catch (err) {
        handleActionError(err);
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, lineDraft, overrideActive, overrideReason],
  );

  // Ctrl+S saves the open editor (header or line). The ref keeps the save
  // callable reachable from the global keydown listener without re-binding.
  const lineSaveRef = useRef<(() => Promise<void>) | null>(null);
  const currentEditingLine = useMemo(
    () => doc?.lines.find((line) => line.id === editingLineId) ?? null,
    [doc, editingLineId],
  );
  useEffect(() => {
    lineSaveRef.current = currentEditingLine ? () => saveLine(currentEditingLine) : null;
  }, [currentEditingLine, saveLine]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (lineSaveRef.current) {
          void lineSaveRef.current();
        } else if (editHeader) {
          void saveHeader();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [editHeader, saveHeader]);

  async function removeLine(line: SalesLineDto) {
    if (!doc) return;
    if (locked && !overrideActive) {
      setActionError("سفارش تأییدشده برای شما قفل است. برای حذف خط از «اصلاح مجاز» استفاده کنید.");
      return;
    }
    setBusy(`line:${line.id}`);
    setActionError(null);
    try {
      const updated = await deleteSaleLine(
        doc.id,
        line.id,
        overrideActive ? overrideReason : undefined,
      );
      setDoc(updated);
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  function handleOverrideSubmit() {
    if (!overrideReason.trim()) {
      setOverrideError("دلیل اصلاح الزامی است.");
      return;
    }
    setOverrideActive(true);
    setOverrideOpen(false);
    setOverrideError(null);
  }

  async function handleAddLine() {
    if (!doc) return;
    setActionError(null);
    if (!newVariant) {
      setActionError("محصول و variant را انتخاب کنید.");
      return;
    }
    const qty = parseDecimalInput(newQuantity);
    if (!qty || Number(qty) <= 0) {
      setActionError("تعداد باید عددی مثبت باشد.");
      return;
    }
    const price = parseDecimalInput(newUnitPrice);
    const discount = parseDecimalInput(newDiscount);
    setBusy("addLine");
    try {
      setDoc(
        await addSaleLine(doc.id, {
          productVariantId: newVariant.variantId,
          quantity: Number(qty),
          ...(price ? { unitPrice: Number(price) } : {}),
          ...(discount ? { discountAmount: Number(discount) } : {}),
          ...(overrideActive ? { overrideReason } : {}),
        }),
      );
      setNewVariant(null);
      setNewQuantity("");
      setNewUnitPrice("");
      setNewDiscount("");
    } catch (err) {
      handleActionError(err);
    } finally {
      setBusy(null);
    }
  }

  const totals = useMemo(() => {
    if (!doc) return null;
    return {
      subtotal: toNum(doc.subtotal),
      discountTotal: toNum(doc.discountTotal),
      taxTotal: toNum(doc.taxTotal),
      total: toNum(doc.total),
    };
  }, [doc]);

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

  const canSend = doc.status === "DRAFT" || doc.status === "QUOTATION";
  const canConfirm = doc.status === "QUOTATION" || doc.status === "SENT";
  const canActivate = doc.status === "CUSTOMER_CONFIRMED";
  const canLost = doc.status === "QUOTATION" || doc.status === "SENT";
  const canCancel = !["COMPLETED", "CANCELLED", "LOST"].includes(doc.status);

  return (
    <div className="space-y-4">
      {/* Version conflict banner */}
      {versionConflict && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800"
          role="alert"
        >
          <span>رکورد تغییر کرده است.</span>
          <Button size="sm" variant="secondary" onClick={() => void reload()}>
            رکورد تغییر کرده — بازخوانی
          </Button>
        </div>
      )}

      {actionError && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700"
          role="alert"
        >
          <span>{actionError}</span>
          <button
            type="button"
            className="text-xs font-bold underline"
            onClick={() => setActionError(null)}
          >
            بستن
          </button>
        </div>
      )}

      {overrideActive && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
          اصلاح با مجاز مدیر فعال است — هر تغییر با ذخیرهٔ دلیل ثبت می‌شود: «{overrideReason.trim()}»
        </div>
      )}

      {/* Related documents + header card */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <section
            className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
            aria-label="سربرگ سند فروش"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 dir="ltr" className="text-lg font-bold text-primary-700">
                    {doc.documentNumber}
                  </h2>
                  <SaleStatusBadge status={doc.status} />
                  {locked && (
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-4 w-4 text-slate-400"
                      aria-label="قفل‌شده"
                    >
                      <rect x="3" y="11" width="18" height="11" rx="2" />
                      <path d="M7 11V7a5 5 0 0110 0v4" />
                    </svg>
                  )}
                </div>
                <p className="mt-1 text-xs text-slate-500">
                  مشتری: <span className="font-medium text-slate-700">{doc.customer?.nameFa ?? "—"}</span>
                  <span className="mx-2 text-slate-300">|</span>
                  فروشنده:{" "}
                  <span className="font-medium text-slate-700">{doc.salesperson?.username ?? "—"}</span>
                  <span className="mx-2 text-slate-300">|</span>
                  ارز: <span dir="ltr">{doc.currency}</span>
                </p>
              </div>

              {/* Actions by status */}
              <div className="flex flex-wrap items-center gap-2">
                {canSend && (
                  <Button
                    size="sm"
                    onClick={() => void runTransition("send")}
                    disabled={busy !== null}
                  >
                    {busy === "send" ? "در حال ارسال…" : "ارسال پیش‌فاکتور"}
                  </Button>
                )}
                {canConfirm && (
                  <Button
                    size="sm"
                    onClick={() => void runTransition("confirm")}
                    disabled={busy !== null}
                  >
                    {busy === "confirm" ? "در حال ثبت…" : "تأیید مشتری"}
                  </Button>
                )}
                {canActivate && (
                  <Button
                    size="sm"
                    onClick={() => void runTransition("activate")}
                    disabled={busy !== null}
                  >
                    {busy === "activate" ? "در حال تبدیل…" : "تبدیل به سفارش فروش"}
                  </Button>
                )}
                {canLost && (
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => setLostOpen(true)}
                    disabled={busy !== null}
                  >
                    ثبت باخت
                  </Button>
                )}
                {canCancel && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => setCancelOpen(true)}
                    disabled={busy !== null}
                  >
                    لغو
                  </Button>
                )}
                {locked && !overrideActive && (
                  <Button size="sm" variant="secondary" onClick={() => setOverrideOpen(true)}>
                    اصلاح مجاز
                  </Button>
                )}
              </div>
            </div>

            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">تاریخ سند</dt>
                <dd className="tabular-nums text-slate-800">{jalali(doc.documentDate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">انقضا</dt>
                <dd className="tabular-nums text-slate-800">{jalali(doc.expirationDate)}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">شرایط پرداخت</dt>
                <dd className="text-slate-800">{doc.paymentTerm?.nameFa ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">استعلام مرجع</dt>
                <dd className="text-slate-800">{doc.priceRequest?.requestNumber ?? "—"}</dd>
              </div>
            </dl>

            {doc.status === "LOST" && doc.lostReason && (
              <p className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                دلیل باخت: {doc.lostReason.nameFa}
              </p>
            )}

            {/* Totals */}
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-100 pt-4 text-sm md:grid-cols-4">
              <div>
                <p className="text-xs text-slate-500">جمع اقلام</p>
                <p className="tabular-nums">
                  {totals?.subtotal !== null ? faDigits(thousandSeparate(totals!.subtotal!)) : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">تخفیف</p>
                <p className="tabular-nums">
                  {totals?.discountTotal !== null
                    ? faDigits(thousandSeparate(totals!.discountTotal!))
                    : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-slate-500">مالیات</p>
                <p className="tabular-nums">
                  {totals?.taxTotal !== null ? faDigits(thousandSeparate(totals!.taxTotal!)) : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs font-medium text-slate-600">مبلغ کل</p>
                <p className="font-bold tabular-nums text-primary-700">
                  {totals?.total !== null ? `${faDigits(thousandSeparate(totals!.total!))} ریال` : "—"}
                </p>
              </div>
            </div>

            {/* Header edit: expiration + payment term (allowed even when locked) */}
            <div className="mt-4 border-t border-slate-100 pt-3">
              {editHeader ? (
                <div className="grid grid-cols-1 items-end gap-3 md:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-slate-600">انقضا</label>
                    <JalaliDateInput
                      value={expirationDate}
                      onChange={setExpirationDate}
                      ariaLabel="تاریخ انقضا"
                    />
                  </div>
                  <div>
                    <label htmlFor="header-term" className="mb-1 block text-xs font-medium text-slate-600">
                      شرایط پرداخت
                    </label>
                    <select
                      id="header-term"
                      value={paymentTermId}
                      onChange={(event) => setPaymentTermId(event.target.value)}
                      className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                    >
                      <option value="">—</option>
                      {paymentTerms.map((term) => (
                        <option key={term.id} value={term.id}>
                          {term.nameFa}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => void saveHeader()} disabled={busy === "header"}>
                      {busy === "header" ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditHeader(false)}>
                      انصراف (Esc)
                    </Button>
                  </div>
                </div>
              ) : (
                <Button size="sm" variant="ghost" onClick={beginHeaderEdit}>
                  ویرایش انقضا / شرایط پرداخت
                </Button>
              )}
            </div>
          </section>
        </div>

        <RelatedDocumentsCard entityType="sales_document" entityId={doc.id} />
      </div>

      {/* Lines */}
      <section
        className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
        aria-label="خطوط سند"
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">
            خطوط سند — {faDigits(doc.lines.length)} ردیف
          </h3>
          <div className="flex items-center gap-2">
            <Link
              href={`/allocations?salesDocumentId=${doc.id}`}
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50"
            >
              تخصیص بار
            </Link>
          </div>
        </div>
        {/* Add line (allowed while unlocked, or with an active manager override) */}
      {(!locked || overrideActive) && (
        <div className="grid grid-cols-1 items-end gap-3 border-b border-slate-100 px-4 py-4 md:grid-cols-2 xl:grid-cols-6">
          <div className="xl:col-span-2">
            <label className="mb-1 block text-xs font-medium text-slate-600">محصول / variant *</label>
            <VariantSelector value={newVariant} onChange={setNewVariant} />
          </div>
          <div>
            <label htmlFor="sd-qty" className="mb-1 block text-xs font-medium text-slate-600">
              تعداد *
            </label>
            <Input
              id="sd-qty"
              inputSize="sm"
              dir="ltr"
              inputMode="decimal"
              value={newQuantity}
              onChange={(event) => setNewQuantity(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAddLine();
              }}
              aria-label="تعداد خط جدید"
            />
          </div>
          <div>
            <label htmlFor="sd-price" className="mb-1 block text-xs font-medium text-slate-600">
              قیمت واحد (ریال)
            </label>
            <Input
              id="sd-price"
              inputSize="sm"
              dir="ltr"
              inputMode="decimal"
              value={newUnitPrice}
              onChange={(event) => setNewUnitPrice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAddLine();
              }}
              aria-label="قیمت واحد خط جدید"
            />
          </div>
          <div>
            <label htmlFor="sd-discount" className="mb-1 block text-xs font-medium text-slate-600">
              تخفیف (ریال)
            </label>
            <Input
              id="sd-discount"
              inputSize="sm"
              dir="ltr"
              inputMode="decimal"
              value={newDiscount}
              onChange={(event) => setNewDiscount(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void handleAddLine();
              }}
              aria-label="تخفیف خط جدید"
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
          <table className="w-full min-w-max border-collapse text-sm" aria-label="جدول خطوط سند فروش">
            <thead>
              <tr className="bg-white text-xs text-slate-500">
                <th scope="col" className="px-3 py-2 text-start">شرح چاپی</th>
                <th scope="col" className="px-3 py-2 text-center">تعداد</th>
                <th scope="col" className="px-3 py-2 text-end">قیمت واحد</th>
                <th scope="col" className="px-3 py-2 text-end">تخفیف</th>
                <th scope="col" className="px-3 py-2 text-end">مالیات</th>
                <th scope="col" className="px-3 py-2 text-end">جمع خط</th>
                <th scope="col" className="px-3 py-2 text-center">ویرایش</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {doc.lines.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs text-slate-400">
                    خطی ثبت نشده است.
                  </td>
                </tr>
              ) : (
                doc.lines.map((line) =>
                  editingLineId === line.id ? (
                    <tr key={line.id} className="bg-primary-50/40">
                      <td className="px-3 py-2">
                        <Input
                          inputSize="sm"
                          value={lineDraft.printableDescription}
                          onChange={(event) =>
                            setLineDraft((draft) => ({
                              ...draft,
                              printableDescription: event.target.value,
                            }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveLine(line);
                            if (event.key === "Escape") setEditingLineId(null);
                          }}
                          aria-label="شرح چاپی"
                        />
                      </td>
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
                      <td className="px-3 py-2 text-end">
                        <Input
                          inputSize="sm"
                          dir="ltr"
                          inputMode="decimal"
                          className="w-24 text-end"
                          value={lineDraft.discount}
                          onChange={(event) =>
                            setLineDraft((draft) => ({ ...draft, discount: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveLine(line);
                            if (event.key === "Escape") setEditingLineId(null);
                          }}
                          aria-label="تخفیف"
                        />
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums text-slate-400">
                        {faDigits(thousandSeparate(toNum(line.taxAmount) ?? 0))}
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
                        {line.printableDescription ?? line.productVariant.nameFa}
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
                      <td className="px-3 py-2 text-end tabular-nums">
                        {faDigits(thousandSeparate(toNum(line.discountAmount) ?? 0))}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">
                        {faDigits(thousandSeparate(toNum(line.taxAmount) ?? 0))}
                      </td>
                      <td className="px-3 py-2 text-end font-medium tabular-nums">
                        {faDigits(thousandSeparate(toNum(line.lineTotal) ?? 0))}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-1">
                          {locked ? (
                            <>
                              <svg
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                className="h-3.5 w-3.5 text-slate-400"
                                aria-label="قفل‌شده"
                              >
                                <rect x="3" y="11" width="18" height="11" rx="2" />
                                <path d="M7 11V7a5 5 0 0110 0v4" />
                              </svg>
                              {overrideActive && (
                                <button
                                  type="button"
                                  onClick={() => beginLineEdit(line)}
                                  className="rounded px-1.5 py-0.5 text-xs font-medium text-primary-600 hover:bg-primary-50"
                                  aria-label={`اصلاح خط ${line.productVariant.sku} با مجاز مدیر`}
                                >
                                  اصلاح
                                </button>
                              )}
                            </>
                          ) : (
                            <>
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
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ),
                )
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Manager override modal */}
      <Modal
        open={overrideOpen}
        title="اصلاح مجاز سفارش تأییدشده"
        onClose={() => setOverrideOpen(false)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setOverrideOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={handleOverrideSubmit}>
              فعال‌سازی اصلاح
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {overrideError && (
            <div
              role="alert"
              className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
            >
              {overrideError}
            </div>
          )}
          <p className="text-xs text-slate-500">
            با فعال‌سازی اصلاح، خطوط قفل‌شده قابل ویرایش می‌شوند و دلیل شما در دفتر ثبت می‌شود.
          </p>
          <label htmlFor="override-reason" className="block text-xs font-medium text-slate-600">
            دلیل اصلاح *
          </label>
          <textarea
            id="override-reason"
            rows={3}
            value={overrideReason}
            onChange={(event) => setOverrideReason(event.target.value)}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            aria-label="دلیل اصلاح"
          />
        </div>
      </Modal>

      {/* Lost modal */}
      <Modal
        open={lostOpen}
        title="ثبت باخت پیش‌فاکتور"
        onClose={() => setLostOpen(false)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setLostOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button
              size="sm"
              variant="danger"
              onClick={() => void handleLost()}
              disabled={busy === "lost"}
            >
              {busy === "lost" ? "در حال ثبت…" : "ثبت باخت"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div>
            <label htmlFor="lost-reason" className="mb-1 block text-xs font-medium text-slate-600">
              دلیل باخت *
            </label>
            <select
              id="lost-reason"
              value={lostReasonId}
              onChange={(event) => setLostReasonId(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">انتخاب کنید…</option>
              {lostReasons.map((reason) => (
                <option key={reason.id} value={reason.id}>
                  {reason.nameFa}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="lost-notes" className="mb-1 block text-xs font-medium text-slate-600">
              توضیحات
            </label>
            <textarea
              id="lost-notes"
              rows={2}
              value={lostNotes}
              onChange={(event) => setLostNotes(event.target.value)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              aria-label="توضیحات باخت"
            />
          </div>
        </div>
      </Modal>

      {/* Cancel confirm */}
      <Modal
        open={cancelOpen}
        title="لغو سند فروش"
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
          آیا از لغو سند <span dir="ltr" className="font-bold">{doc.documentNumber}</span> مطمئن
          هستید؟ این عمل بازگشت‌پذیر نیست.
        </p>
      </Modal>
    </div>
  );
}
