"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { faDigits, thousandSeparate, toNum } from "@/lib/format";
import { parseDecimalInput, fetchAllCategories, fetchAllBrands } from "@/lib/product";
import { apiJson } from "@/lib/api";
import {
  BULK_PRICE_MODES,
  BULK_PRICE_MODE_LABELS,
  DAILY_PRICE_SOURCE_LABELS,
  bulkSkipReason,
  bulkUpdatePrices,
  fetchDailyGrid,
  pricingErrorMessage,
  upsertDailyPrice,
  type BulkPriceMode,
  type BulkPriceUpdateResult,
  type DailyPriceGridRow,
} from "@/lib/pricing";

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function partyMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  return { id, label: typeof item.nameFa === "string" && item.nameFa ? item.nameFa : id };
}

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

interface RowDraft {
  price: string;
  supplierId: string | null;
}

/** Supplier selector for one grid row; resolves an existing id to its name. */
function SupplierCell({
  supplierId,
  onChange,
  onSaveShortcut,
  onFocused,
}: {
  supplierId: string | null;
  onChange: (supplierId: string | null) => void;
  onSaveShortcut: () => void;
  onFocused: () => void;
}) {
  const [value, setValue] = useState<EntityOption | null>(null);

  // Resolve the stored supplier id to a display name once per id change.
  useEffect(() => {
    let cancelled = false;
    if (!supplierId) {
      setValue(null);
      return;
    }
    setValue((current) => (current && current.id === supplierId ? current : null));
    void (async () => {
      try {
        const party = await apiJson<{ id: string; nameFa?: string }>(`/parties/${supplierId}`);
        if (!cancelled) {
          setValue({ id: party.id, label: party.nameFa || party.id });
        }
      } catch {
        if (!cancelled) setValue({ id: supplierId, label: supplierId.slice(0, 8) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [supplierId]);

  return (
    <div
      className="w-44"
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
          event.preventDefault();
          onSaveShortcut();
        }
      }}
      onFocus={onFocused}
    >
      <EntitySelector
        endpoint={(search) =>
          `/parties?role=SUPPLIER&search=${encodeURIComponent(search)}&pageSize=10`
        }
        mapItem={partyMapItem}
        value={value}
        onChange={(option) => {
          setValue(option);
          onChange(option ? option.id : null);
        }}
        placeholder="تامین‌کننده…"
        ariaLabel="تامین‌کننده پیشنهادی"
      />
    </div>
  );
}

/** Price delta arrow + percent badge for the دیروز column. */
function DeltaBadge({ row }: { row: DailyPriceGridRow }) {
  const delta = toNum(row.delta);
  const yesterday = toNum(row.yesterdayPrice?.price);
  if (delta === null || yesterday === null) return <span className="text-slate-300">—</span>;
  if (delta === 0) {
    return (
      <span className="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">
        بدون تغییر
      </span>
    );
  }
  const percent = Math.abs((delta / yesterday) * 100);
  const percentText = Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
  if (delta > 0) {
    return (
      <span className="inline-flex items-center gap-0.5 rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
        <span aria-hidden="true">▲</span>
        {faDigits(percentText)}٪
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[10px] font-bold text-red-700">
      <span aria-hidden="true">▼</span>
      {faDigits(percentText)}٪
    </span>
  );
}

function PricingWorkbench() {
  // Filters
  const [dateIso, setDateIso] = useState<string>(todayIso);
  const [categoryId, setCategoryId] = useState<string>("");
  const [brandId, setBrandId] = useState<string>("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [showChangedOnly, setShowChangedOnly] = useState(false);

  // Data
  const [categories, setCategories] = useState<{ id: string; nameFa: string }[]>([]);
  const [brands, setBrands] = useState<{ id: string; nameFa: string }[]>([]);
  const [rows, setRows] = useState<DailyPriceGridRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Row editing
  const [drafts, setDrafts] = useState<Record<string, RowDraft>>({});
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const activeVariantRef = useRef<string | null>(null);
  const saveRowRef = useRef<(variantId: string) => void>(() => {});

  // Bulk toolbar
  const [bulkMode, setBulkMode] = useState<BulkPriceMode>("PERCENT_UP");
  const [bulkAmount, setBulkAmount] = useState("");
  const [bulkConfirmOpen, setBulkConfirmOpen] = useState(false);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkResult, setBulkResult] = useState<BulkPriceUpdateResult | null>(null);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const pageSize = 20;

  // Debounced search.
  useEffect(() => {
    const timer = setTimeout(() => {
      const term = searchInput.trim();
      setSearch((current) => {
        if (current !== term) setPage(1);
        return term;
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    void (async () => {
      try {
        const [categoryList, brandList] = await Promise.all([
          fetchAllCategories("true"),
          fetchAllBrands("true"),
        ]);
        setCategories(categoryList.map((c) => ({ id: c.id, nameFa: c.nameFa })));
        setBrands(brandList.map((b) => ({ id: b.id, nameFa: b.nameFa })));
      } catch {
        // Filter dropdowns stay empty; the grid still works.
      }
    })();
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchDailyGrid({
        date: dateIso,
        page,
        pageSize,
        ...(categoryId ? { categoryId } : {}),
        ...(brandId ? { brandId } : {}),
        ...(search ? { search } : {}),
      });
      setRows(result.items);
      setTotal(result.total);
      setDrafts((current) => {
        const next = { ...current };
        for (const item of result.items) {
          if (next[item.variantId]) continue;
          next[item.variantId] = {
            price:
              item.todayPrice && toNum(item.todayPrice.price) !== null
                ? thousandSeparate(toNum(item.todayPrice.price))
                : "",
            supplierId: item.todayPrice?.supplierPartyId ?? null,
          };
        }
        return next;
      });
    } catch (err) {
      setError(pricingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [dateIso, categoryId, brandId, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  // Filter to rows that have a yesterday price (client-side, current page).
  const visibleRows = useMemo(
    () => (showChangedOnly ? rows.filter((row) => row.delta !== null) : rows),
    [rows, showChangedOnly],
  );

  function setDraft(variantId: string, patch: Partial<RowDraft>) {
    setDrafts((current) => ({
      ...current,
      [variantId]: { ...(current[variantId] ?? { price: "", supplierId: null }), ...patch },
    }));
  }

  const saveRow = useCallback(
    async (variantId: string) => {
      const row = rows.find((item) => item.variantId === variantId);
      const draft = drafts[variantId];
      if (!row || !draft || savingIds.has(variantId)) return;
      const price = parseDecimalInput(draft.price);
      if (!price || Number(price) < 0) {
        setRowErrors((current) => ({ ...current, [variantId]: "قیمت معتبر وارد کنید." }));
        return;
      }
      if (!row.defaultUomId) {
        setRowErrors((current) => ({
          ...current,
          [variantId]: "این محصول واحد اندازه‌گیری پیش‌فرض ندارد.",
        }));
        return;
      }
      setSavingIds((current) => new Set(current).add(variantId));
      setRowErrors((current) => {
        const next = { ...current };
        delete next[variantId];
        return next;
      });
      try {
        await upsertDailyPrice({
          productVariantId: variantId,
          date: dateIso,
          uomId: row.defaultUomId,
          price: Number(price),
          ...(draft.supplierId ? { supplierPartyId: draft.supplierId } : {}),
        });
        setNotice("قیمت ثبت شد.");
        setDrafts((current) => {
          const next = { ...current };
          delete next[variantId];
          return next;
        });
        await load();
      } catch (err) {
        setRowErrors((current) => ({ ...current, [variantId]: pricingErrorMessage(err) }));
      } finally {
        setSavingIds((current) => {
          const next = new Set(current);
          next.delete(variantId);
          return next;
        });
      }
    },
    [rows, drafts, savingIds, dateIso, load],
  );

  // Keep a ref to the latest saveRow for the document-level Ctrl+S handler.
  useEffect(() => {
    saveRowRef.current = (variantId: string) => {
      void saveRow(variantId);
    };
  }, [saveRow]);

  // Global Ctrl+S saves the row the operator last focused.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (activeVariantRef.current) saveRowRef.current(activeVariantRef.current);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function handlePriceKeyDown(event: KeyboardEvent<HTMLInputElement>, variantId: string) {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveRow(variantId);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void saveRow(variantId);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      const row = rows.find((item) => item.variantId === variantId);
      setDraft(variantId, {
        price:
          row?.todayPrice && toNum(row.todayPrice.price) !== null
            ? thousandSeparate(toNum(row.todayPrice.price))
            : "",
        supplierId: row?.todayPrice?.supplierPartyId ?? null,
      });
      setRowErrors((current) => {
        const next = { ...current };
        delete next[variantId];
        return next;
      });
    }
  }

  // ── bulk update ──

  const bulkTargetLabel = useMemo(() => {
    if (selection.size > 0) return `${faDigits(selection.size)} ردیف انتخاب‌شده`;
    const parts: string[] = [];
    if (categoryId) {
      const category = categories.find((c) => c.id === categoryId);
      parts.push(`گروه «${category?.nameFa ?? "؟"}»`);
    }
    if (brandId) {
      const brand = brands.find((b) => b.id === brandId);
      parts.push(`برند «${brand?.nameFa ?? "؟"}»`);
    }
    return parts.length > 0 ? parts.join(" و ") : null;
  }, [selection, categoryId, brandId, categories, brands]);

  async function applyBulk() {
    const amount = parseDecimalInput(bulkAmount);
    if (!amount || Number(amount) < 0) {
      setBulkError("مقدار افزایش/کاهش را وارد کنید.");
      return;
    }
    if (!bulkTargetLabel) {
      setBulkError("هدف اعمال گروهی را مشخص کنید: ردیف‌ها را انتخاب کنید یا گروه/برند فیلتر کنید.");
      return;
    }
    setBulkRunning(true);
    setBulkError(null);
    try {
      const result = await bulkUpdatePrices({
        date: dateIso,
        mode: bulkMode,
        amount: Number(amount),
        ...(selection.size > 0
          ? { variantIds: Array.from(selection) }
          : {
              filter: {
                ...(categoryId ? { categoryId } : {}),
                ...(brandId ? { brandId } : {}),
              },
            }),
      });
      setBulkResult(result);
      setBulkConfirmOpen(false);
      setSelection(new Set());
      await load();
    } catch (err) {
      setBulkError(pricingErrorMessage(err));
    } finally {
      setBulkRunning(false);
    }
  }

  // ── grid columns ──

  const columns = useMemo<DataTableColumn<DailyPriceGridRow>[]>(() => {
    return [
      {
        key: "product",
        header: "محصول",
        render: (row) => (
          <div className="min-w-48">
            <p className="text-xs font-semibold text-slate-800">{row.template?.nameFa ?? "—"}</p>
            <p className="text-[11px] text-slate-500">
              {row.nameFa}
              <span dir="ltr" className="ms-1.5 text-[10px] text-slate-400">
                {row.sku}
              </span>
            </p>
          </div>
        ),
      },
      {
        key: "brand",
        header: "برند",
        render: (row) => (
          <span className="text-xs text-slate-600">{row.template?.brandNameFa ?? "—"}</span>
        ),
      },
      {
        key: "today",
        header: "قیمت امروز",
        render: (row) => {
          const draft = drafts[row.variantId] ?? { price: "", supplierId: null };
          const rowError = rowErrors[row.variantId];
          const disabled = !row.defaultUomId || savingIds.has(row.variantId);
          return (
            <div>
              <div className="flex items-center gap-1">
                <Input
                  inputSize="sm"
                  dir="ltr"
                  inputMode="decimal"
                  aria-label={`قیمت امروز ${row.nameFa}`}
                  placeholder={
                    row.todayPrice && toNum(row.todayPrice.price) !== null
                      ? thousandSeparate(toNum(row.todayPrice.price))
                      : "قیمت…"
                  }
                  value={draft.price}
                  disabled={disabled}
                  onFocus={() => {
                    activeVariantRef.current = row.variantId;
                  }}
                  onChange={(event) => setDraft(row.variantId, { price: event.target.value })}
                  onKeyDown={(event) => handlePriceKeyDown(event, row.variantId)}
                  className="w-36 font-medium tabular-nums"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void saveRow(row.variantId)}
                  disabled={disabled}
                  aria-label={`ذخیره قیمت ${row.nameFa}`}
                  title="ذخیره (Enter)"
                >
                  ذخیره
                </Button>
              </div>
              {rowError && <p className="mt-1 text-[11px] text-red-600">{rowError}</p>}
            </div>
          );
        },
      },
      {
        key: "yesterday",
        header: "دیروز",
        render: (row) => {
          const yesterday = toNum(row.yesterdayPrice?.price);
          return (
            <div className="flex flex-col items-start gap-1">
              <span className="text-xs tabular-nums text-slate-600">
                {yesterday !== null ? faDigits(thousandSeparate(yesterday)) : "—"}
              </span>
              <DeltaBadge row={row} />
            </div>
          );
        },
      },
      {
        key: "supplier",
        header: "تامین‌کننده پیشنهادی",
        render: (row) => {
          const draft = drafts[row.variantId] ?? { price: "", supplierId: null };
          return (
            <SupplierCell
              supplierId={draft.supplierId}
              onChange={(supplierId) => setDraft(row.variantId, { supplierId })}
              onSaveShortcut={() => void saveRow(row.variantId)}
              onFocused={() => {
                activeVariantRef.current = row.variantId;
              }}
            />
          );
        },
      },
      {
        key: "source",
        header: "منبع",
        render: (row) => (
          <span className="text-[11px] text-slate-500">
            {row.todayPrice ? DAILY_PRICE_SOURCE_LABELS[row.todayPrice.source] ?? row.todayPrice.source : "—"}
          </span>
        ),
      },
      {
        key: "status",
        header: "وضعیت",
        render: (row) =>
          row.todayPrice ? (
            <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
              ثبت‌شده
            </span>
          ) : (
            <span className="rounded border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">
              جدید
            </span>
          ),
      },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, rowErrors, savingIds, rows, saveRow]);

  const isPastDate = dateIso < todayIso();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">میز کار قیمت روز</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            قیمت هر محصول برای یک روز ثبت می‌شود — Enter یا Ctrl+S ذخیره می‌کند، Enter روی ردیف تاریخچه را باز می‌کند
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div>
            <label htmlFor="pricing-date" className={fieldLabel}>
              تاریخ
            </label>
            <div className="w-40">
              <JalaliDateInput
                value={dateIso}
                onChange={(iso) => {
                  setPage(1);
                  setSelection(new Set());
                  if (iso) setDateIso(iso);
                }}
                ariaLabel="تاریخ قیمت"
              />
            </div>
          </div>
          <Button variant="secondary" onClick={() => setDateIso(todayIso())} aria-label="بازگشت به امروز">
            امروز
          </Button>
        </div>
      </div>

      {isPastDate && (
        <div role="note" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-700">
          تاریخ گذشته انتخاب شده است؛ ثبت یا ویرایش قیمت روزهای گذشته فقط با دسترسی «ویرایش تاریخچه قیمت» مجاز است.
        </div>
      )}

      {/* Filters + bulk toolbar */}
      <div className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <div className="w-44">
          <label htmlFor="pricing-category" className={fieldLabel}>
            گروه کالایی
          </label>
          <select
            id="pricing-category"
            value={categoryId}
            onChange={(event) => {
              setCategoryId(event.target.value);
              setPage(1);
            }}
            className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه گروه‌ها</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.nameFa}
              </option>
            ))}
          </select>
        </div>
        <div className="w-40">
          <label htmlFor="pricing-brand" className={fieldLabel}>
            برند
          </label>
          <select
            id="pricing-brand"
            value={brandId}
            onChange={(event) => {
              setBrandId(event.target.value);
              setPage(1);
            }}
            className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه برندها</option>
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.nameFa}
              </option>
            ))}
          </select>
        </div>
        <div className="min-w-48 flex-1">
          <label htmlFor="pricing-search" className={fieldLabel}>
            جستجو
          </label>
          <Input
            id="pricing-search"
            inputSize="md"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="نام محصول، variant یا SKU…"
            aria-label="جستجوی محصول"
          />
        </div>
        <label className="mb-2 flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={showChangedOnly}
            onChange={(event) => setShowChangedOnly(event.target.checked)}
            className="h-4 w-4 accent-primary-600"
          />
          نمایش تغییرات دیروز
        </label>

        <div className="ms-auto flex flex-wrap items-end gap-2 border-s-0 pe-0">
          <div className="w-44">
            <label htmlFor="bulk-mode" className={fieldLabel}>
              اعمال گروهی
            </label>
            <select
              id="bulk-mode"
              value={bulkMode}
              onChange={(event) => setBulkMode(event.target.value as BulkPriceMode)}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              {BULK_PRICE_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {BULK_PRICE_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </div>
          <div className="w-28">
            <label htmlFor="bulk-amount" className={fieldLabel}>
              مقدار
            </label>
            <Input
              id="bulk-amount"
              inputSize="md"
              dir="ltr"
              inputMode="decimal"
              value={bulkAmount}
              onChange={(event) => setBulkAmount(event.target.value)}
              aria-label="مقدار تغییر گروهی قیمت"
            />
          </div>
          <Button
            onClick={() => {
              setBulkError(null);
              setBulkConfirmOpen(true);
            }}
            aria-label="اعمال تغییر گروهی قیمت"
          >
            اعمال
          </Button>
        </div>
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

      <DataTable<DailyPriceGridRow>
        columns={columns}
        rows={visibleRows}
        rowKey={(row) => row.variantId}
        rowHref={(row) => `/pricing/history/${row.variantId}`}
        getRowAriaLabel={(row) => `باز کردن تاریخچه قیمت ${row.nameFa}`}
        selectable
        selectedKeys={selection}
        onSelectedChange={setSelection}
        dense
        loading={loading}
        ariaLabel="شبکه قیمت روز"
        pagination={{
          page,
          pageSize,
          total,
          onPageChange: setPage,
        }}
      />

      {/* Bulk confirm */}
      <Modal
        open={bulkConfirmOpen}
        title="اعمال تغییر گروهی قیمت"
        onClose={() => setBulkConfirmOpen(false)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setBulkConfirmOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void applyBulk()} disabled={bulkRunning}>
              {bulkRunning ? "در حال اعمال…" : "تأیید و اعمال"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {bulkError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {bulkError}
            </div>
          )}
          <p className="text-sm text-slate-700">
            {BULK_PRICE_MODE_LABELS[bulkMode]} به مقدار{" "}
            <span dir="ltr" className="font-bold tabular-nums">
              {faDigits(bulkAmount)}
            </span>{" "}
            برای {bulkTargetLabel ?? "—"} اعمال شود؟
          </p>
          <p className="text-xs text-slate-500">
            تغییر گروهی روی قیمت‌های روز انتخابی (ایجاد یا به‌روزرسانی) اعمال می‌شود. ردیف‌هایی که واحد ندارند یا قیمت‌شان منفی
            می‌شود رد خواهند شد.
          </p>
        </div>
      </Modal>

      {/* Bulk result */}
      <Modal
        open={bulkResult !== null}
        title="گزارش تغییر گروهی قیمت"
        onClose={() => setBulkResult(null)}
        footer={
          <Button size="sm" onClick={() => setBulkResult(null)}>
            بستن
          </Button>
        }
      >
        {bulkResult && (
          <div className="space-y-3">
            <div className="flex gap-3 text-sm">
              <span className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-1.5 font-bold text-emerald-700">
                موفق: {faDigits(bulkResult.updated)}
              </span>
              <span className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 font-bold text-amber-700">
                رد شده: {faDigits(bulkResult.skipped)}
              </span>
            </div>
            {bulkResult.items.some((item) => item.skipped) && (
              <div className="max-h-56 overflow-y-auto rounded-md border border-slate-200">
                <table className="w-full text-xs" aria-label="دلایل رد شدن ردیف‌ها">
                  <thead>
                    <tr className="bg-slate-50 text-slate-500">
                      <th scope="col" className="px-2 py-1.5 text-start">محصول</th>
                      <th scope="col" className="px-2 py-1.5 text-start">دلیل</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {bulkResult.items
                      .filter((item) => item.skipped)
                      .map((item) => {
                        const row = rows.find((r) => r.variantId === item.variantId);
                        return (
                          <tr key={item.variantId}>
                            <td className="px-2 py-1.5 text-slate-700">
                              {row?.nameFa ?? item.variantId.slice(0, 8)}
                            </td>
                            <td className="px-2 py-1.5 text-amber-700">
                              {item.skipped ? bulkSkipReason(item.skipped) : "—"}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function PricingPage() {
  return <PricingWorkbench />;
}
