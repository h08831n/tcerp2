"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { faDigits, toNum, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import {
  allocationErrorMessage,
  createAllocation,
  deleteAllocation,
  fetchAllocations,
  type AllocationDto,
} from "@/lib/allocations";
import { fetchSale, salesErrorMessage, type SalesDocumentDetail, type SalesLineDto } from "@/lib/sales";
import {
  fetchPurchase,
  purchaseErrorMessage,
  type PurchaseDocumentDetail,
  type PurchaseLineDto,
} from "@/lib/purchase";

function saleMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const number = typeof item.documentNumber === "string" ? item.documentNumber : id;
  const customerName =
    (item.customer as { nameFa?: string } | undefined)?.nameFa ?? "";
  return { id, label: number, sublabel: customerName || undefined };
}

function purchaseMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const number = typeof item.documentNumber === "string" ? item.documentNumber : id;
  const supplierName =
    (item.supplier as { nameFa?: string } | undefined)?.nameFa ?? "";
  return { id, label: number, sublabel: supplierName || undefined };
}

/** Allocated quantity per sales line id, summed from the doc's allocations. */
function allocatedBySalesLine(allocations: AllocationDto[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const allocation of allocations) {
    map.set(
      allocation.sales.lineId,
      (map.get(allocation.sales.lineId) ?? 0) + (toNum(allocation.allocatedQuantity) ?? 0),
    );
  }
  return map;
}

/** Allocated quantity per purchase line id across ALL sales documents. */
function allocatedByPurchaseLine(allocations: AllocationDto[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const allocation of allocations) {
    map.set(
      allocation.purchase.lineId,
      (map.get(allocation.purchase.lineId) ?? 0) + (toNum(allocation.allocatedQuantity) ?? 0),
    );
  }
  return map;
}

function AllocationsWorkbench() {
  const searchParams = useSearchParams();
  const initialSalesDocumentId = searchParams?.get("salesDocumentId") ?? "";

  const [saleOption, setSaleOption] = useState<EntityOption | null>(
    initialSalesDocumentId ? { id: initialSalesDocumentId, label: "سند انتخاب‌شده" } : null,
  );
  const [sale, setSale] = useState<SalesDocumentDetail | null>(null);
  const [allocations, setAllocations] = useState<AllocationDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Allocation editor state (per sales line).
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [purchaseOption, setPurchaseOption] = useState<EntityOption | null>(null);
  const [purchaseDoc, setPurchaseDoc] = useState<PurchaseDocumentDetail | null>(null);
  const [purchaseAllocations, setPurchaseAllocations] = useState<AllocationDto[]>([]);
  const [selectedPurchaseLineId, setSelectedPurchaseLineId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const loadSale = useCallback(async (saleId: string) => {
    setLoading(true);
    setError(null);
    setSale(null);
    setAllocations([]);
    setActiveLineId(null);
    setPurchaseOption(null);
    setPurchaseDoc(null);
    try {
      const [detail, allocs] = await Promise.all([
        fetchSale(saleId),
        fetchAllocations({ salesDocumentId: saleId }),
      ]);
      setSale(detail);
      setAllocations(allocs.items);
    } catch (err) {
      setError(err instanceof Error ? salesErrorMessage(err) : "خطا در دریافت سند فروش");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialSalesDocumentId) void loadSale(initialSalesDocumentId);
  }, [initialSalesDocumentId, loadSale]);

  const salesAllocated = useMemo(() => allocatedBySalesLine(allocations), [allocations]);
  const purchaseAllocated = useMemo(
    () => allocatedByPurchaseLine(purchaseAllocations),
    [purchaseAllocations],
  );

  const activeLine = useMemo(
    () => sale?.lines.find((line) => line.id === activeLineId) ?? null,
    [sale, activeLineId],
  );

  // Purchase lines with the SAME variant and remaining quantity > 0.
  const candidates = useMemo(() => {
    if (!purchaseDoc || !activeLine) return [];
    return purchaseDoc.lines
      .filter((line: PurchaseLineDto) => line.productVariantId === activeLine.productVariantId)
      .map((line: PurchaseLineDto) => {
        const ordered = toNum(line.orderedQuantity) ?? 0;
        const allocated = purchaseAllocated.get(line.id) ?? 0;
        return { line, remaining: ordered - allocated };
      })
      .filter((entry) => entry.remaining > 0);
  }, [purchaseDoc, activeLine, purchaseAllocated]);

  function openLineEditor(line: SalesLineDto) {
    setActiveLineId(line.id);
    setPurchaseOption(null);
    setPurchaseDoc(null);
    setPurchaseAllocations([]);
    setSelectedPurchaseLineId("");
    setQuantity("");
    setCreateError(null);
    setSuccess(null);
  }

  async function loadPurchase(purchaseId: string) {
    setPurchaseDoc(null);
    setPurchaseAllocations([]);
    setSelectedPurchaseLineId("");
    setCreateError(null);
    try {
      const [detail, allocs] = await Promise.all([
        fetchPurchase(purchaseId),
        fetchAllocations({ purchaseDocumentId: purchaseId }),
      ]);
      setPurchaseDoc(detail);
      setPurchaseAllocations(allocs.items);
      if (detail.lines.every((line) => line.productVariantId !== activeLine?.productVariantId)) {
        setCreateError("در این سند خرید، خطی با همان محصولِ خط فروش وجود ندارد.");
      }
    } catch (err) {
      setCreateError(purchaseErrorMessage(err));
    }
  }

  async function handleCreate() {
    if (!activeLine || !selectedPurchaseLineId) return;
    const qty = parseDecimalInput(quantity);
    if (!qty || Number(qty) <= 0) {
      setCreateError("مقدار تخصیص باید مثبت باشد.");
      return;
    }
    setCreating(true);
    setCreateError(null);
    setSuccess(null);
    try {
      await createAllocation({
        salesLineId: activeLine.id,
        purchaseLineId: selectedPurchaseLineId,
        allocatedQuantity: Number(qty),
      });
      setSuccess("تخصیص ثبت شد.");
      setQuantity("");
      // Refresh both sides' remaining quantities.
      if (sale) {
        const allocs = await fetchAllocations({ salesDocumentId: sale.id });
        setAllocations(allocs.items);
      }
      if (purchaseOption) {
        const allocs = await fetchAllocations({ purchaseDocumentId: purchaseOption.id });
        setPurchaseAllocations(allocs.items);
      }
    } catch (err) {
      setCreateError(allocationErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(allocation: AllocationDto) {
    setDeletingId(allocation.id);
    setError(null);
    try {
      await deleteAllocation(allocation.id);
      setAllocations((current) => current.filter((item) => item.id !== allocation.id));
      if (purchaseOption) {
        const allocs = await fetchAllocations({ purchaseDocumentId: purchaseOption.id });
        setPurchaseAllocations(allocs.items);
      }
    } catch (err) {
      setError(allocationErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  }

  const allocationsBySalesLine = useMemo(() => {
    const map = new Map<string, AllocationDto[]>();
    for (const allocation of allocations) {
      const list = map.get(allocation.sales.lineId) ?? [];
      list.push(allocation);
      map.set(allocation.sales.lineId, list);
    }
    return map;
  }, [allocations]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-800">تخصیص بار</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          اتصال خطوط خرید به خطوط فروش (M:N) — یک خط فروش می‌تواند از چند خط خرید تأمین شود
        </p>
      </div>

      {/* Sales document selector */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <label className="mb-1 block text-xs font-medium text-slate-600">سند فروش</label>
        <div className="max-w-md">
          <EntitySelector
            endpoint={(q) => `/sales?search=${encodeURIComponent(q)}&pageSize=10`}
            mapItem={saleMapItem}
            value={saleOption}
            onChange={(next) => {
              setSaleOption(next);
              if (next) void loadSale(next.id);
              else {
                setSale(null);
                setAllocations([]);
                setActiveLineId(null);
              }
            }}
            placeholder="جستجوی شماره سند یا مشتری…"
            ariaLabel="انتخاب سند فروش"
            emptySearchLabel="برای جستجوی سند تایپ کنید"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {success && (
        <div role="status" className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {success}
        </div>
      )}
      {loading && <p className="text-sm text-slate-400">در حال بارگذاری…</p>}

      {sale && (
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            سند <span dir="ltr" className="font-bold text-primary-700">{sale.documentNumber}</span> —
            مشتری: {sale.customer?.nameFa ?? "—"} — وضعیت خطوط: {faDigits(sale.lines.length)} ردیف
          </p>

          {sale.lines.length === 0 && (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
              این سند خط ندارد؛ ابتدا خطوط فروش را ثبت کنید.
            </p>
          )}

          {sale.lines.map((line) => {
            const ordered = toNum(line.orderedQuantity) ?? 0;
            const allocated = salesAllocated.get(line.id) ?? 0;
            const remaining = ordered - allocated;
            const lineAllocations = allocationsBySalesLine.get(line.id) ?? [];
            const isActive = activeLineId === line.id;
            return (
              <div
                key={line.id}
                className={`rounded-xl border bg-white p-4 shadow-sm ${
                  isActive ? "border-primary-300" : "border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-slate-800">
                      {line.printableDescription ?? line.productVariant.nameFa}
                      <span dir="ltr" className="ms-2 text-[10px] text-slate-400">
                        {line.productVariant.sku}
                      </span>
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 tabular-nums">
                      سفارش: {faDigits(ordered)} {line.uom?.symbol} — تخصیص‌یافته:{" "}
                      <span className="font-medium text-emerald-700">{faDigits(allocated)}</span> —
                      باقی‌مانده:{" "}
                      <span
                        className={`font-medium ${remaining > 0 ? "text-amber-700" : "text-slate-400"}`}
                      >
                        {faDigits(remaining)}
                      </span>
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant={isActive ? "secondary" : "primary"}
                    onClick={() => (isActive ? setActiveLineId(null) : openLineEditor(line))}
                    disabled={remaining <= 0 && !isActive}
                  >
                    {isActive ? "بستن" : "تخصیص"}
                  </Button>
                </div>

                {/* Existing allocations */}
                {lineAllocations.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-slate-100 pt-2">
                    {lineAllocations.map((allocation) => (
                      <li
                        key={allocation.id}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-slate-50 px-2.5 py-1.5 text-xs"
                      >
                        <span className="text-slate-600">
                          از سند خرید{" "}
                          <span dir="ltr" className="font-medium text-primary-700">
                            {allocation.purchase.documentNumber}
                          </span>{" "}
                          — {faDigits(thousandSeparate(toNum(allocation.allocatedQuantity) ?? 0))}
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleDelete(allocation)}
                          disabled={deletingId === allocation.id}
                          className="rounded px-1.5 py-0.5 font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
                        >
                          {deletingId === allocation.id ? "…" : "حذف"}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {/* Allocation editor */}
                {isActive && (
                  <div className="mt-3 space-y-3 border-t border-slate-100 pt-3">
                    <div className="max-w-md">
                      <label className="mb-1 block text-xs font-medium text-slate-600">
                        سند خرید (برای یافتن خطوط هم‌محصول)
                      </label>
                      <EntitySelector
                        endpoint={(q) => `/purchase?search=${encodeURIComponent(q)}&pageSize=10`}
                        mapItem={purchaseMapItem}
                        value={purchaseOption}
                        onChange={(next) => {
                          setPurchaseOption(next);
                          if (next) void loadPurchase(next.id);
                          else {
                            setPurchaseDoc(null);
                            setPurchaseAllocations([]);
                            setSelectedPurchaseLineId("");
                          }
                        }}
                        placeholder="جستجوی شماره سند خرید…"
                        ariaLabel="انتخاب سند خرید"
                        emptySearchLabel="برای جستجو تایپ کنید"
                      />
                    </div>

                    {createError && (
                      <div
                        role="alert"
                        className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
                      >
                        {createError}
                      </div>
                    )}

                    {purchaseDoc && candidates.length > 0 && (
                      <div className="space-y-2">
                        <p className="text-xs font-medium text-slate-600">
                          خطوط خرید با همان محصول و باقی‌ماندهٔ مثبت:
                        </p>
                        <ul className="space-y-1">
                          {candidates.map(({ line, remaining }) => (
                            <li key={line.id}>
                              <label
                                className={`flex cursor-pointer items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs transition-colors ${
                                  selectedPurchaseLineId === line.id
                                    ? "border-primary-400 bg-primary-50"
                                    : "border-slate-200 hover:bg-slate-50"
                                }`}
                              >
                                <span className="flex items-center gap-2">
                                  <input
                                    type="radio"
                                    name={`purchase-line-${activeLineId}`}
                                    checked={selectedPurchaseLineId === line.id}
                                    onChange={() => setSelectedPurchaseLineId(line.id)}
                                    className="h-3.5 w-3.5 accent-primary-600"
                                  />
                                  <span dir="ltr" className="text-slate-700">
                                    {purchaseDoc.documentNumber}
                                  </span>
                                  <span className="text-slate-500">{line.productVariant.nameFa}</span>
                                </span>
                                <span className="tabular-nums text-slate-600">
                                  باقی‌مانده: {faDigits(remaining)} {line.uom?.symbol}
                                </span>
                              </label>
                            </li>
                          ))}
                        </ul>
                        <div className="flex flex-wrap items-end gap-2">
                          <div className="w-40">
                            <label htmlFor={`alloc-qty-${activeLineId}`} className="mb-1 block text-xs font-medium text-slate-600">
                              مقدار تخصیص *
                            </label>
                            <Input
                              id={`alloc-qty-${activeLineId}`}
                              inputSize="sm"
                              dir="ltr"
                              inputMode="decimal"
                              value={quantity}
                              onChange={(event) => setQuantity(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") void handleCreate();
                              }}
                              aria-label="مقدار تخصیص"
                            />
                          </div>
                          <Button
                            size="sm"
                            onClick={() => void handleCreate()}
                            disabled={creating || !selectedPurchaseLineId}
                          >
                            {creating ? "در حال ثبت…" : "ثبت تخصیص (Enter)"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <p className="text-xs text-slate-400">
        <Link href="/sales" className="text-primary-600 underline">
          بازگشت به فهرست فروش
        </Link>
      </p>
    </div>
  );
}

export default function AllocationsPage() {
  // useSearchParams needs a Suspense boundary during prerendering.
  return (
    <Suspense fallback={<p className="text-sm text-slate-400">در حال بارگذاری…</p>}>
      <AllocationsWorkbench />
    </Suspense>
  );
}
