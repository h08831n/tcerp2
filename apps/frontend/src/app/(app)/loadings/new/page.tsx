"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { jalaliDateTime, toNum } from "@/lib/format";
import { fetchAllUoms } from "@/lib/product";
import {
  createLoading,
  loadingErrorMessage,
  type LoadingAllocationInput,
  type LoadingLineInput,
} from "@/lib/loading";

interface UomOption {
  id: string;
  symbol: string;
  nameFa: string;
}

interface LineDraft {
  variant: VariantSelection | null;
  quantity: string;
  uomId: string;
  notes: string;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

export default function NewLoadingPage() {
  const router = useRouter();
  const [loadingDate, setLoadingDate] = useState(todayIso());
  const [warehouseId, setWarehouseId] = useState("");
  const [customer, setCustomer] = useState<EntityOption | null>(null);
  const [driver, setDriver] = useState<EntityOption | null>(null);
  const [carrier, setCarrier] = useState<EntityOption | null>(null);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([
    { variant: null, quantity: "", uomId: "", notes: "" },
  ]);
  const [uoms, setUoms] = useState<UomOption[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void fetchAllUoms()
      .then(setUoms)
      .catch(() => undefined);
  }, []);

  const updateLine = useCallback((index: number, patch: Partial<LineDraft>) => {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }, []);

  const partyEndpoint = (role: string) => (q: string) =>
    `/parties?role=${role}&search=${encodeURIComponent(q)}&pageSize=10`;

  const save = async () => {
    setError(null);
    const valid = lines.filter((l) => l.variant && (toNum(l.quantity) ?? 0) > 0);
    if (valid.length === 0) {
      setError("حداقل یک خط با کالا و مقدار معتبر لازم است.");
      return;
    }
    const lineInputs: LoadingLineInput[] = valid.map((l) => ({
      productVariantId: (l.variant as NonNullable<LineDraft["variant"]>).variantId,
      actualQuantity: toNum(l.quantity) ?? 0,
      ...(l.uomId ? { uomId: l.uomId } : {}),
      ...(l.notes ? { notes: l.notes } : {}),
    }));
    setBusy(true);
    try {
      const created = await createLoading({
        loadingDate,
        ...(warehouseId ? { warehouseId } : {}),
        ...(customer ? { customerPartyId: customer.id } : {}),
        ...(driver ? { driverPartyId: driver.id } : {}),
        ...(carrier ? { carrierPartyId: carrier.id } : {}),
        ...(notes ? { notes } : {}),
        lines: lineInputs,
      });
      router.replace(`/loadings/${created.id}`);
    } catch (e) {
      setError(loadingErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadingDate, warehouseId, customer, driver, carrier, notes, lines]);

  return (
    <div className="space-y-5">
      <h1 className="text-lg font-bold text-slate-800">بارگیری جدید</h1>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">تاریخ بارگیری</label>
            <Input value={loadingDate} onChange={(e) => setLoadingDate(e.target.value)} aria-label="تاریخ بارگیری" />
            <p className="mt-1 text-xs text-slate-400">{jalaliDateTime(new Date().toISOString())}</p>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">مشتری (اختیاری)</label>
            <EntitySelector
              endpoint={partyEndpoint("CUSTOMER")}
              value={customer}
              onChange={setCustomer}
              placeholder="جستجوی مشتری"
              ariaLabel="انتخاب مشتری"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">انبار (اختیاری — پیش‌فرض شرکت)</label>
            <select
              aria-label="انتخاب انبار"
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
              value={warehouseId}
              onChange={(e) => setWarehouseId(e.target.value)}
            >
              <option value="">پیش‌فرض</option>
              <WarehousesOptions />
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">راننده (اختیاری)</label>
            <EntitySelector
              endpoint={partyEndpoint("DRIVER")}
              value={driver}
              onChange={setDriver}
              placeholder="جستجوی راننده"
              ariaLabel="انتخاب راننده"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">ناقل (اختیاری)</label>
            <EntitySelector
              endpoint={partyEndpoint("CARRIER")}
              value={carrier}
              onChange={setCarrier}
              placeholder="جستجوی ناقل"
              ariaLabel="انتخاب ناقل"
            />
          </div>
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-600">یادداشت</label>
          <Input value={notes} onChange={(e) => setNotes(e.target.value)} aria-label="یادداشت" />
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-700">خطوط بارگیری</h2>
          <Button
            variant="secondary"
            onClick={() => setLines((prev) => [...prev, { variant: null, quantity: "", uomId: "", notes: "" }])}
          >
            افزودن خط
          </Button>
        </div>
        {lines.map((line, index) => (
          <div key={index} className="grid grid-cols-1 items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 md:grid-cols-4">
            <div className="md:col-span-2">
              <label className="mb-1 block text-xs font-medium text-slate-600">کالا</label>
              <VariantSelector
                value={line.variant}
                onChange={(v) => updateLine(index, { variant: v, uomId: "" })}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">مقدار واقعی</label>
              <Input
                type="number"
                min="0"
                value={line.quantity}
                onChange={(e) => updateLine(index, { quantity: e.target.value })}
                aria-label={`مقدار خط ${index + 1}`}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">واحد (اختیاری)</label>
              <select
                aria-label={`واحد خط ${index + 1}`}
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm"
                value={line.uomId}
                onChange={(e) => updateLine(index, { uomId: e.target.value })}
              >
                <option value="">واحد پیش‌فرض کالا</option>
                {uoms.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.symbol} — {u.nameFa}
                  </option>
                ))}
              </select>
            </div>
            {lines.length > 1 && (
              <Button
                variant="danger"
                onClick={() => setLines((prev) => prev.filter((_, i) => i !== index))}
              >
                حذف خط
              </Button>
            )}
          </div>
        ))}
      </section>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

      <div className="flex gap-2">
        <Button variant="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "در حال ثبت…" : "ثبت پیش‌نویس (Ctrl+S)"}
        </Button>
        <Button variant="ghost" onClick={() => router.back()}>
          انصراف
        </Button>
      </div>
      <p className="text-xs text-slate-500">
        تخصیص خطوط به سفارش فروش/خرید پس از ثبت، در صفحه جزئیات انجام می‌شود. بارگیری در لحظه تأیید موجودی انبار را
        به‌صورت خودکار ثبت می‌کند.
      </p>
    </div>
  );
}

function WarehousesOptions() {
  const [options, setOptions] = useState<EntityOption[]>([]);
  useEffect(() => {
    import("@/lib/inventory")
      .then(({ fetchWarehouses }) => fetchWarehouses())
      .then((ws) =>
        setOptions(ws.map((w) => ({ id: w.id, label: `${w.nameFa} (${w.code})` }))),
      )
      .catch(() => undefined);
  }, []);
  return (
    <>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </>
  );
}
