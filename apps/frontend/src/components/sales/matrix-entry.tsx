"use client";

import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { faDigits } from "@/lib/format";
import { fetchMatrix, type MatrixCell, type MatrixSpace } from "@/lib/product";

export interface MatrixEntryCell {
  productVariantId: string;
  quantity: number;
}

interface GridCell {
  rowValueId: string;
  columnValueId: string;
  variantId: string;
  sku: string;
}

function mapTemplate(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const nameFa = typeof item.nameFa === "string" ? item.nameFa : id;
  const internalCode = typeof item.internalCode === "string" ? item.internalCode : "";
  return { id, label: nameFa, sublabel: internalCode || undefined };
}

/**
 * Matrix line entry for a sales document (REQUIREMENTS §9 grid):
 * pick a product template → GET /products/templates/:id/matrix → editable
 * quantity grid. Keyboard: Arrow keys move between cells, Enter confirms the
 * cell and moves down, Tab navigates naturally. Empty cells are never
 * submitted (backend skips them; MATRIX_EMPTY when nothing is filled).
 */
export function MatrixEntry({
  onSubmit,
  submitting,
  disabled = false,
}: {
  onSubmit: (cells: MatrixEntryCell[]) => Promise<void>;
  submitting: boolean;
  disabled?: boolean;
}) {
  const [template, setTemplate] = useState<EntityOption | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [columns, setColumns] = useState<MatrixSpace | null>(null);
  const [rows, setRows] = useState<MatrixSpace | null>(null);
  const [cellIndex, setCellIndex] = useState<Map<string, GridCell>>(new Map());
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const columnValues = columns?.values ?? [];
  const rowValues = rows?.values ?? [];

  const gridVariantIds = useMemo(() => {
    const ids = new Set<string>();
    cellIndex.forEach((cell) => ids.add(cell.variantId));
    return ids;
  }, [cellIndex]);

  const filledCount = useMemo(() => {
    let count = 0;
    for (const [variantId, raw] of Object.entries(quantities)) {
      if (!gridVariantIds.has(variantId)) continue;
      const normalized = Number(raw.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
      if (Number.isFinite(normalized) && normalized > 0) count += 1;
    }
    return count;
  }, [quantities, gridVariantIds]);

  async function loadMatrix(templateId: string) {
    setLoading(true);
    setError(null);
    setColumns(null);
    setRows(null);
    setCellIndex(new Map());
    setQuantities({});
    try {
      const result = await fetchMatrix(templateId);
      // The matrix view contract: rows[0]/columns[0] hold the two axes.
      setColumns(result.columns[0] ?? null);
      setRows(result.rows[0] ?? null);
      const index = new Map<string, GridCell>();
      for (const cell of result.cells as MatrixCell[]) {
        const valueIds = cell.combination.map((pair) => pair.valueId);
        for (const rowValue of result.rows[0]?.values ?? []) {
          for (const columnValue of result.columns[0]?.values ?? []) {
            if (valueIds.includes(rowValue.id) && valueIds.includes(columnValue.id)) {
              index.set(`${rowValue.id}|${columnValue.id}`, {
                rowValueId: rowValue.id,
                columnValueId: columnValue.id,
                variantId: cell.variantId,
                sku: cell.sku,
              });
            }
          }
        }
        // Single-axis matrix: both values on one axis.
        if ((result.rows[0]?.values ?? []).length === 0) {
          for (const columnValue of result.columns[0]?.values ?? []) {
            if (valueIds.includes(columnValue.id)) {
              index.set(`|${columnValue.id}`, {
                rowValueId: "",
                columnValueId: columnValue.id,
                variantId: cell.variantId,
                sku: cell.sku,
              });
            }
          }
        }
        if ((result.columns[0]?.values ?? []).length === 0) {
          for (const rowValue of result.rows[0]?.values ?? []) {
            if (valueIds.includes(rowValue.id)) {
              index.set(`${rowValue.id}|`, {
                rowValueId: rowValue.id,
                columnValueId: "",
                variantId: cell.variantId,
                sku: cell.sku,
              });
            }
          }
        }
      }
      setCellIndex(index);
      if (index.size === 0) {
        setError("این محصول variant فعالی برای ماتریس ندارد.");
      }
    } catch {
      setError("خطا در دریافت ماتریس محصول");
      setColumns(null);
      setRows(null);
      setCellIndex(new Map());
    } finally {
      setLoading(false);
    }
  }

  const gridRowCount = rowValues.length > 0 ? rowValues.length : 1;
  const gridColCount = columnValues.length > 0 ? columnValues.length : 1;

  function cellAt(rowIndex: number, colIndex: number): GridCell | undefined {
    const rowValue = rowValues[rowIndex];
    const columnValue = columnValues[colIndex];
    return cellIndex.get(`${rowValue?.id ?? ""}|${columnValue?.id ?? ""}`);
  }

  function focusCell(rowIndex: number, colIndex: number) {
    const clampedRow = Math.max(0, Math.min(rowIndex, gridRowCount - 1));
    const clampedCol = Math.max(0, Math.min(colIndex, gridColCount - 1));
    inputRefs.current[clampedRow * gridColCount + clampedCol]?.focus();
  }

  function handleCellKeyDown(
    event: KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number,
  ) {
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        focusCell(rowIndex - 1, colIndex);
        break;
      case "ArrowDown":
        event.preventDefault();
        focusCell(rowIndex + 1, colIndex);
        break;
      case "ArrowLeft":
        // RTL grid: left arrow moves to the visually-left (previous) cell.
        event.preventDefault();
        focusCell(rowIndex, colIndex - 1);
        break;
      case "ArrowRight":
        event.preventDefault();
        focusCell(rowIndex, colIndex + 1);
        break;
      case "Enter":
        // Confirm the cell, then move down (Excel-style).
        event.preventDefault();
        (event.target as HTMLInputElement).blur();
        if (rowIndex + 1 < gridRowCount) focusCell(rowIndex + 1, colIndex);
        break;
      default:
        break;
    }
  }

  async function handleSubmit() {
    setError(null);
    const cells: MatrixEntryCell[] = [];
    cellIndex.forEach((cell) => {
      const raw = quantities[cell.variantId];
      if (!raw) return;
      const normalized = Number(raw.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))));
      if (Number.isFinite(normalized) && normalized > 0) {
        cells.push({ productVariantId: cell.variantId, quantity: normalized });
      }
    });
    if (cells.length === 0) {
      setError("حداقل برای یک سلول تعداد وارد کنید.");
      return;
    }
    try {
      await onSubmit(cells);
      setQuantities({});
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "خطا در ثبت خطوط");
    }
  }

  return (
    <div className="space-y-3">
      <EntitySelector
        endpoint={(search) =>
          `/products/templates?search=${encodeURIComponent(search)}&pageSize=10&active=true`
        }
        mapItem={mapTemplate}
        value={template}
        onChange={(next) => {
          setTemplate(next);
          setQuantities({});
          setError(null);
          if (next) void loadMatrix(next.id);
          else {
            setColumns(null);
            setRows(null);
            setCellIndex(new Map());
          }
        }}
        placeholder="جستجوی خانواده محصول…"
        ariaLabel="انتخاب خانواده محصول برای ماتریس"
        disabled={disabled}
        emptySearchLabel="برای جستجوی محصول تایپ کنید"
      />

      {loading && <p className="text-xs text-slate-400">در حال دریافت ماتریس…</p>}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      {template && !loading && cellIndex.size > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="شبکه ماتریس تعداد">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-500">
                <th scope="col" className="border-b border-slate-200 px-3 py-2 text-start">
                  {rows ? rows.nameFa : ""}
                  {rows && columns ? " / " : ""}
                  {columns ? columns.nameFa : ""}
                </th>
                {columnValues.map((columnValue) => (
                  <th
                    key={columnValue.id}
                    scope="col"
                    className="border-b border-slate-200 px-3 py-2 text-center"
                  >
                    {columnValue.valueFa}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(rowValues.length > 0 ? rowValues : [null]).map((rowValue, rowIndex) => (
                <tr key={rowValue?.id ?? "single"} className="text-slate-700">
                  <td className="px-3 py-1.5 text-start text-xs font-medium">
                    {rowValue?.valueFa ?? (rowValues.length === 0 ? columns?.nameFa ?? "تعداد" : "")}
                  </td>
                  {(columnValues.length > 0 ? columnValues : [null]).map((columnValue, colIndex) => {
                    const gridCell = cellAt(rowIndex, colIndex);
                    const inputIndex = rowIndex * gridColCount + colIndex;
                    return (
                      <td key={columnValue?.id ?? "single"} className="px-2 py-1.5 text-center">
                        {gridCell ? (
                          <div className="flex flex-col items-center gap-0.5">
                            <input
                              ref={(el) => {
                                inputRefs.current[inputIndex] = el;
                              }}
                              type="text"
                              inputMode="decimal"
                              dir="ltr"
                              value={faDigits(quantities[gridCell.variantId] ?? "")}
                              onChange={(event) => {
                                const latin = event.target.value.replace(
                                  /[۰-۹]/g,
                                  (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)),
                                );
                                if (latin !== "" && !/^\d*\.?\d*$/.test(latin)) return;
                                setQuantities((current) => ({
                                  ...current,
                                  [gridCell.variantId]: latin,
                                }));
                              }}
                              onKeyDown={(event) =>
                                handleCellKeyDown(event, rowIndex, colIndex)
                              }
                              aria-label={`تعداد برای ${rowValue?.valueFa ?? ""} ${columnValue?.valueFa ?? ""}`}
                              className="h-8 w-20 rounded border border-slate-300 bg-white text-center text-sm tabular-nums focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                            />
                            <span dir="ltr" className="text-[10px] text-slate-300">
                              {gridCell.sku}
                            </span>
                          </div>
                        ) : (
                          <span className="text-slate-200">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {template && !loading && cellIndex.size > 0 && (
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={disabled || submitting || filledCount === 0}
          >
            {submitting
              ? "در حال ثبت…"
              : `ثبت خطوط ماتریس (${faDigits(filledCount)} سلول پرشده)`}
          </Button>
          <span className="text-[11px] text-slate-400">
            جهت‌نما: کلیدهای جهت برای حرکت بین سلول‌ها، Enter برای تأیید و رد شدن
          </span>
        </div>
      )}
    </div>
  );
}
