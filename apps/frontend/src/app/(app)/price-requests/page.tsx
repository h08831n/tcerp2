"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { PriceRequestStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali, jalaliDateTime, toNum, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import {
  createPriceRequest,
  createPurchaseFromRequest,
  createSaleFromRequest,
  closePriceRequest,
  addOffer,
  deleteOffer,
  priceRequestErrorMessage,
  fetchPriceRequestWorklist,
  fetchPriceRequest,
  type PriceRequestDetail,
  type WorklistRequestDto,
} from "@/lib/price-request";
import { fetchDocumentRelations } from "@/lib/document-flow";

function partyMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  return { id, label: typeof item.nameFa === "string" && item.nameFa ? item.nameFa : id };
}

interface DraftLine {
  key: string;
  variant: VariantSelection | null;
  quantity: string;
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function PriceRequestsWorkbench() {
  const router = useRouter();

  const [worklist, setWorklist] = useState<{ today: WorklistRequestDto[]; previousDays: WorklistRequestDto[] } | null>(
    null,
  );
  const [view, setView] = useState<"today" | "previousDays">("today");
  const [details, setDetails] = useState<Record<string, PriceRequestDetail>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Create request form.
  const [createOpen, setCreateOpen] = useState(false);
  const [createCustomer, setCreateCustomer] = useState<EntityOption | null>(null);
  const [createLines, setCreateLines] = useState<DraftLine[]>([{ key: "l0", variant: null, quantity: "" }]);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Add-offer form per line.
  const [offerLineId, setOfferLineId] = useState<string | null>(null);
  const [offerSupplier, setOfferSupplier] = useState<EntityOption | null>(null);
  const [offerPrice, setOfferPrice] = useState("");
  const [offerPaymentTerms, setOfferPaymentTerms] = useState("");
  const [offerDelivery, setOfferDelivery] = useState("");
  const [savingOffer, setSavingOffer] = useState(false);
  const [offerError, setOfferError] = useState<string | null>(null);

  // create-sale / create-purchase modals.
  const [saleTarget, setSaleTarget] = useState<WorklistRequestDto | null>(null);
  const [saleCustomer, setSaleCustomer] = useState<EntityOption | null>(null);
  const [saleCreating, setSaleCreating] = useState(false);
  const [saleError, setSaleError] = useState<string | null>(null);
  const [purchaseTarget, setPurchaseTarget] = useState<WorklistRequestDto | null>(null);
  const [purchaseSupplier, setPurchaseSupplier] = useState<EntityOption | null>(null);
  const [purchaseCreating, setPurchaseCreating] = useState(false);
  const [purchaseError, setPurchaseError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPriceRequestWorklist();
      setWorklist({ today: result.today, previousDays: result.previousDays });
      // Details for offers + today price (worklist projection lacks them).
      const ids = [...result.today, ...result.previousDays].map((request) => request.id);
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await fetchPriceRequest(id)] as const;
          } catch {
            return null;
          }
        }),
      );
      const map: Record<string, PriceRequestDetail> = {};
      for (const entry of entries) {
        if (entry) map[entry[0]] = entry[1];
      }
      setDetails(map);
    } catch (err) {
      setError(priceRequestErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => (worklist ? worklist[view] : []), [worklist, view]);

  function openOfferForm(lineId: string) {
    setOfferLineId(lineId);
    setOfferSupplier(null);
    setOfferPrice("");
    setOfferPaymentTerms("");
    setOfferDelivery("");
    setOfferError(null);
  }

  async function handleAddOffer() {
    if (!offerLineId) return;
    if (!offerSupplier) {
      setOfferError("انتخاب تامین‌کننده الزامی است.");
      return;
    }
    const price = parseDecimalInput(offerPrice);
    if (!price || Number(price) <= 0) {
      setOfferError("قیمت پیشنهاد باید عددی مثبت باشد.");
      return;
    }
    setSavingOffer(true);
    setOfferError(null);
    try {
      await addOffer(offerLineId, {
        supplierPartyId: offerSupplier.id,
        offeredPrice: Number(price),
        ...(offerPaymentTerms.trim() ? { paymentTerms: offerPaymentTerms.trim() } : {}),
        ...(offerDelivery.trim() ? { deliveryTime: offerDelivery.trim() } : {}),
      });
      setOfferLineId(null);
      await load();
    } catch (err) {
      setOfferError(priceRequestErrorMessage(err));
    } finally {
      setSavingOffer(false);
    }
  }

  async function handleDeleteOffer(detail: PriceRequestDetail, lineId: string, offerId: string) {
    setError(null);
    try {
      await deleteOffer(lineId, offerId);
      setDetails((current) => ({
        ...current,
        [detail.id]: {
          ...current[detail.id],
          lines: current[detail.id].lines.map((line) =>
            line.id === lineId
              ? { ...line, offers: (line.offers ?? []).filter((offer) => offer.id !== offerId) }
              : line,
          ),
        },
      }));
    } catch (err) {
      setError(priceRequestErrorMessage(err));
    }
  }

  async function handleCreateRequest() {
    setCreateError(null);
    const filled = createLines.filter((line) => line.variant && parseDecimalInput(line.quantity));
    if (filled.length === 0) {
      setCreateError("حداقل یک خط با محصول و تعداد وارد کنید.");
      return;
    }
    setCreating(true);
    try {
      await createPriceRequest({
        customerPartyId: createCustomer?.id,
        requestDate: todayIso(),
        lines: filled.map((line) => ({
          productVariantId: line.variant!.variantId,
          requestedQuantity: Number(parseDecimalInput(line.quantity)),
        })),
      });
      setCreateOpen(false);
      setCreateCustomer(null);
      setCreateLines([{ key: `l${Date.now()}`, variant: null, quantity: "" }]);
      await load();
      setNotice("درخواست قیمت ثبت شد.");
    } catch (err) {
      setCreateError(priceRequestErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  function beginCreateSale(request: WorklistRequestDto) {
    setSaleTarget(request);
    setSaleCustomer(request.customer ? { id: request.customer.id, label: request.customer.nameFa } : null);
    setSaleError(null);
  }

  async function handleCreateSale() {
    if (!saleTarget) return;
    if (!saleCustomer) {
      setSaleError("این درخواست مشتری ندارد؛ انتخاب مشتری الزامی است.");
      return;
    }
    setSaleCreating(true);
    setSaleError(null);
    try {
      await createSaleFromRequest(saleTarget.id, { customerPartyId: saleCustomer.id });
      // The backend returns the request; resolve the created sale via relations.
      let saleId: string | null = null;
      try {
        const relations = await fetchDocumentRelations("price_request", saleTarget.id);
        const salesGroup = relations.relations
          .filter((group) => group.type === "sales_document")
          .flatMap((group) => group.items)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
        saleId = salesGroup[0]?.id ?? null;
      } catch {
        saleId = null;
      }
      await load();
      setSaleTarget(null);
      if (saleId) router.push(`/sales/${saleId}`);
      else setNotice("فروش ایجاد شد؛ از فهرست فروش باز کنید.");
    } catch (err) {
      setSaleError(priceRequestErrorMessage(err));
    } finally {
      setSaleCreating(false);
    }
  }

  function beginCreatePurchase(request: WorklistRequestDto) {
    setPurchaseTarget(request);
    setPurchaseSupplier(null);
    setPurchaseError(null);
  }

  async function handleCreatePurchase() {
    if (!purchaseTarget) return;
    if (!purchaseSupplier) {
      setPurchaseError("انتخاب تامین‌کننده الزامی است.");
      return;
    }
    setPurchaseCreating(true);
    setPurchaseError(null);
    try {
      const result = await createPurchaseFromRequest(purchaseTarget.id, {
        supplierPartyId: purchaseSupplier.id,
      });
      await load();
      setPurchaseTarget(null);
      if (result.createdPurchaseId) router.push(`/purchases/${result.createdPurchaseId}`);
    } catch (err) {
      setPurchaseError(priceRequestErrorMessage(err));
    } finally {
      setPurchaseCreating(false);
    }
  }

  async function handleClose(request: WorklistRequestDto) {
    setError(null);
    try {
      await closePriceRequest(request.id);
      await load();
    } catch (err) {
      setError(priceRequestErrorMessage(err));
    }
  }

  function addDraftLine() {
    setCreateLines((current) => [...current, { key: `l${Date.now()}`, variant: null, quantity: "" }]);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">درخواست‌های قیمت</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            میز کار روزانه — درخواست‌های روزهای قبل هرگز کپی نمی‌شوند؛ همان رکورد باز می‌ماند
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} aria-label="ثبت درخواست قیمت جدید">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          درخواست جدید
        </Button>
      </div>

      <div className="flex overflow-hidden rounded-md border border-slate-300 bg-white" role="tablist" aria-label="بازه میز کار">
        <button
          type="button"
          role="tab"
          aria-selected={view === "today"}
          onClick={() => setView("today")}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            view === "today" ? "bg-primary-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          امروز {worklist ? `(${faDigits(worklist.today.length)})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "previousDays"}
          onClick={() => setView("previousDays")}
          className={`px-4 py-2 text-xs font-medium transition-colors ${
            view === "previousDays" ? "bg-primary-600 text-white" : "bg-white text-slate-600 hover:bg-slate-50"
          }`}
        >
          روزهای قبل {worklist ? `(${faDigits(worklist.previousDays.length)})` : ""}
        </button>
      </div>

      {notice && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {loading && !worklist && <p className="text-sm text-slate-400">در حال بارگذاری میز کار…</p>}

      {worklist && items.length === 0 && (
        <p className="rounded-md border border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-400">
          {view === "today"
            ? "برای امروز درخواست بازی وجود ندارد."
            : "درخواست بی‌پاسخی از روزهای قبل باقی نمانده است."}
        </p>
      )}

      {/* Request cards */}
      <div className="space-y-4">
        {items.map((request) => {
          const detail = details[request.id];
          return (
            <article
              key={request.id}
              className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"
              aria-label={`درخواست ${request.requestNumber}`}
            >
              <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 bg-slate-50/70 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="text-sm font-bold text-primary-700">
                    {request.requestNumber}
                  </span>
                  <PriceRequestStatusBadge status={request.status} />
                  <span className="text-xs text-slate-500">
                    مشتری: {request.customer?.nameFa ?? "—"}
                    <span className="mx-2 text-slate-300">|</span>
                    ثبت‌کننده: {request.requester?.username ?? "—"}
                    <span className="mx-2 text-slate-300">|</span>
                    <span className="tabular-nums">{jalali(request.requestDate)}</span>
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="secondary" onClick={() => beginCreateSale(request)}>
                    ایجاد فروش
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => beginCreatePurchase(request)}>
                    ایجاد خرید
                  </Button>
                  {(request.status === "OPEN" || request.status === "OFFERED") && (
                    <Button size="sm" variant="ghost" onClick={() => void handleClose(request)}>
                      بستن
                    </Button>
                  )}
                </div>
              </header>

              <div className="overflow-x-auto px-4 py-3">
                {(detail?.lines ?? request.lines).map((line) => {
                  const offers = line.offers ?? [];
                  const minPrice =
                    offers.length > 0
                      ? Math.min(...offers.map((offer) => toNum(offer.offeredPrice) ?? Infinity))
                      : null;
                  return (
                    <div key={line.id} className="mb-4 last:mb-0">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-sm font-medium text-slate-800">
                          {line.productVariant.nameFa}
                          <span dir="ltr" className="ms-2 text-[10px] text-slate-400">
                            {line.productVariant.sku}
                          </span>
                        </p>
                        <div className="flex items-center gap-3 text-xs">
                          <span className="tabular-nums text-slate-600">
                            تعداد: {faDigits(toNum(line.requestedQuantity) ?? 0)}{" "}
                            <span className="text-slate-400">{line.uom?.symbol}</span>
                          </span>
                          <span className="tabular-nums text-slate-400">
                            قیمت امروز:{" "}
                            {line.todayPrice !== undefined && line.todayPrice !== null
                              ? faDigits(thousandSeparate(toNum(line.todayPrice) ?? 0))
                              : "—"}
                          </span>
                          {detail && (
                            <button
                              type="button"
                              onClick={() => openOfferForm(line.id)}
                              className="rounded border border-primary-200 bg-primary-50 px-2 py-0.5 font-medium text-primary-700 hover:bg-primary-100"
                            >
                              افزودن پیشنهاد
                            </button>
                          )}
                        </div>
                      </div>

                      {/* Offers side-by-side table */}
                      {offers.length > 0 ? (
                        <table
                          className="mt-2 w-full min-w-max border-collapse text-xs"
                          aria-label={`پیشنهادهای خط ${line.productVariant.nameFa}`}
                        >
                          <thead>
                            <tr className="text-slate-500">
                              <th scope="col" className="px-2 py-1 text-start">تامین‌کننده</th>
                              <th scope="col" className="px-2 py-1 text-end">قیمت (ریال)</th>
                              <th scope="col" className="px-2 py-1 text-start">شرایط پرداخت</th>
                              <th scope="col" className="px-2 py-1 text-start">تحویل</th>
                              <th scope="col" className="px-2 py-1 text-center">وضعیت</th>
                              <th scope="col" className="px-2 py-1 text-center">حذف</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {offers.map((offer) => {
                              const price = toNum(offer.offeredPrice);
                              const isLowest = price !== null && minPrice !== null && price === minPrice;
                              return (
                                <tr key={offer.id} className={isLowest ? "bg-emerald-50/70" : ""}>
                                  <td className="px-2 py-1.5 text-slate-700">{offer.supplier?.nameFa}</td>
                                  <td className="px-2 py-1.5 text-end tabular-nums text-slate-800">
                                    {faDigits(thousandSeparate(price))}
                                  </td>
                                  <td className="px-2 py-1.5 text-slate-600">{offer.paymentTerms ?? "—"}</td>
                                  <td className="px-2 py-1.5 text-slate-600">{offer.deliveryTime ?? "—"}</td>
                                  <td className="px-2 py-1.5 text-center">
                                    {isLowest ? (
                                      <span className="rounded border border-emerald-300 bg-emerald-100 px-1.5 py-0.5 text-[10px] font-bold text-emerald-800">
                                        کمترین
                                      </span>
                                    ) : (
                                      <span className="text-slate-300">—</span>
                                    )}
                                  </td>
                                  <td className="px-2 py-1.5 text-center">
                                    <button
                                      type="button"
                                      onClick={() => void handleDeleteOffer(detail!, line.id, offer.id)}
                                      className="rounded px-1 py-0.5 font-medium text-red-500 hover:bg-red-50"
                                      aria-label={`حذف پیشنهاد ${offer.supplier?.nameFa}`}
                                    >
                                      حذف
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      ) : (
                        <p className="mt-1 text-xs text-slate-400">هنوز پیشنهادی ثبت نشده است.</p>
                      )}

                      {/* Add-offer inline form */}
                      {detail && offerLineId === line.id && (
                        <div className="mt-2 rounded-lg border border-primary-200 bg-primary-50/40 p-3">
                          {offerError && (
                            <div role="alert" className="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-700">
                              {offerError}
                            </div>
                          )}
                          <div className="grid grid-cols-1 items-end gap-2 md:grid-cols-4 xl:grid-cols-5">
                            <div className="xl:col-span-2">
                              <label className="mb-1 block text-xs font-medium text-slate-600">
                                تامین‌کننده *
                              </label>
                              <EntitySelector
                                endpoint={(q) =>
                                  `/parties?role=SUPPLIER&search=${encodeURIComponent(q)}&pageSize=10`
                                }
                                mapItem={partyMapItem}
                                value={offerSupplier}
                                onChange={setOfferSupplier}
                                placeholder="جستجوی تامین‌کننده…"
                                ariaLabel="انتخاب تامین‌کننده پیشنهاد"
                              />
                            </div>
                            <div>
                              <label htmlFor={`offer-price-${line.id}`} className="mb-1 block text-xs font-medium text-slate-600">
                                قیمت (ریال) *
                              </label>
                              <Input
                                id={`offer-price-${line.id}`}
                                inputSize="sm"
                                dir="ltr"
                                inputMode="decimal"
                                value={offerPrice}
                                onChange={(event) => setOfferPrice(event.target.value)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter") void handleAddOffer();
                                }}
                                aria-label="قیمت پیشنهاد"
                              />
                            </div>
                            <div>
                              <label htmlFor={`offer-terms-${line.id}`} className="mb-1 block text-xs font-medium text-slate-600">
                                شرایط پرداخت
                              </label>
                              <Input
                                id={`offer-terms-${line.id}`}
                                inputSize="sm"
                                value={offerPaymentTerms}
                                onChange={(event) => setOfferPaymentTerms(event.target.value)}
                                aria-label="شرایط پرداخت پیشنهاد"
                              />
                            </div>
                            <div>
                              <label htmlFor={`offer-delivery-${line.id}`} className="mb-1 block text-xs font-medium text-slate-600">
                                زمان تحویل
                              </label>
                              <div className="flex gap-1">
                                <Input
                                  id={`offer-delivery-${line.id}`}
                                  inputSize="sm"
                                  value={offerDelivery}
                                  onChange={(event) => setOfferDelivery(event.target.value)}
                                  aria-label="زمان تحویل پیشنهاد"
                                />
                                <Button size="sm" onClick={() => void handleAddOffer()} disabled={savingOffer}>
                                  ثبت
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setOfferLineId(null)}>
                                  انصراف
                                </Button>
                              </div>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
                {!detail && (
                  <p className="text-xs text-slate-400">در حال دریافت جزئیات و پیشنهادها…</p>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {/* Create request modal */}
      <Modal
        open={createOpen}
        title="ثبت درخواست قیمت جدید"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleCreateRequest()} disabled={creating}>
              {creating ? "در حال ثبت…" : "ثبت (Ctrl+Enter)"}
            </Button>
          </>
        }
      >
        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.ctrlKey && event.key === "Enter") void handleCreateRequest();
          }}
        >
          {createError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {createError}
            </div>
          )}
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              مشتری (اختیاری)
            </label>
            <EntitySelector
              endpoint={(q) => `/parties?role=CUSTOMER&search=${encodeURIComponent(q)}&pageSize=10`}
              mapItem={partyMapItem}
              value={createCustomer}
              onChange={setCreateCustomer}
              placeholder="بدون مشتری"
              ariaLabel="انتخاب مشتری درخواست"
              emptySearchLabel="برای جستجو تایپ کنید"
            />
          </div>
          <div className="space-y-2">
            <p className="text-xs font-medium text-slate-600">خطوط درخواست</p>
            {createLines.map((line, index) => (
              <div key={line.key} className="grid grid-cols-1 items-end gap-2 md:grid-cols-[1fr_120px_70px]">
                <div>
                  <label className="mb-1 block text-xs font-medium text-slate-600">
                    محصول {index + 1}
                  </label>
                  <VariantSelector
                    value={line.variant}
                    onChange={(variant) =>
                      setCreateLines((current) =>
                        current.map((item) =>
                          item.key === line.key ? { ...item, variant } : item,
                        ),
                      )
                    }
                  />
                </div>
                <div>
                  <label htmlFor={`rq-qty-${line.key}`} className="mb-1 block text-xs font-medium text-slate-600">
                    تعداد
                  </label>
                  <Input
                    id={`rq-qty-${line.key}`}
                    inputSize="sm"
                    dir="ltr"
                    inputMode="decimal"
                    value={line.quantity}
                    onChange={(event) =>
                      setCreateLines((current) =>
                        current.map((item) =>
                          item.key === line.key ? { ...item, quantity: event.target.value } : item,
                        ),
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addDraftLine();
                      }
                    }}
                    aria-label={`تعداد خط ${index + 1}`}
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setCreateLines((current) => current.filter((item) => item.key !== line.key))
                  }
                  disabled={createLines.length === 1}
                >
                  حذف
                </Button>
              </div>
            ))}
            <Button size="sm" variant="secondary" onClick={addDraftLine}>
              افزودن خط
            </Button>
          </div>
        </div>
      </Modal>

      {/* Create sale modal */}
      <Modal
        open={saleTarget !== null}
        title={`ایجاد فروش از ${saleTarget?.requestNumber ?? ""}`}
        onClose={() => setSaleTarget(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setSaleTarget(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleCreateSale()} disabled={saleCreating}>
              {saleCreating ? "در حال ایجاد…" : "ایجاد فروش"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {saleError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {saleError}
            </div>
          )}
          <p className="text-xs text-slate-500">
            همه خطوط درخواست با تعداد درخواستی و قیمت صفر کپی می‌شوند؛ قیمت‌ها را در صفحه پیش‌فاکتور وارد کنید.
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">
              مشتری {saleTarget?.customer ? "" : "(الزامی — درخواست مشتری ندارد)"}
            </label>
            <EntitySelector
              endpoint={(q) => `/parties?role=CUSTOMER&search=${encodeURIComponent(q)}&pageSize=10`}
              mapItem={partyMapItem}
              value={saleCustomer}
              onChange={setSaleCustomer}
              placeholder="جستجوی مشتری…"
              ariaLabel="انتخاب مشتری برای فروش"
            />
          </div>
        </div>
      </Modal>

      {/* Create purchase modal */}
      <Modal
        open={purchaseTarget !== null}
        title={`ایجاد خرید از ${purchaseTarget?.requestNumber ?? ""}`}
        onClose={() => setPurchaseTarget(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setPurchaseTarget(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleCreatePurchase()} disabled={purchaseCreating}>
              {purchaseCreating ? "در حال ایجاد…" : "ایجاد خرید"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {purchaseError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {purchaseError}
            </div>
          )}
          <p className="text-xs text-slate-500">
            همه خطوط درخواست با تعداد درخواستی کپی می‌شوند؛ قیمت از بهترین پیشنهاد آن تامین‌کننده پر نمی‌شود مگر انتخاب کنید.
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">تامین‌کننده *</label>
            <EntitySelector
              endpoint={(q) => `/parties?role=SUPPLIER&search=${encodeURIComponent(q)}&pageSize=10`}
              mapItem={partyMapItem}
              value={purchaseSupplier}
              onChange={setPurchaseSupplier}
              placeholder="جستجوی تامین‌کننده…"
              ariaLabel="انتخاب تامین‌کننده برای خرید"
            />
          </div>
        </div>
      </Modal>
    </div>
  );
}

export default function PriceRequestsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-400">در حال بارگذاری…</p>}>
      <PriceRequestsWorkbench />
    </Suspense>
  );
}
