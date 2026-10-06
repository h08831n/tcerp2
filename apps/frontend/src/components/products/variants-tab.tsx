"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  faDigits,
} from "@/lib/format";
import {
  fetchMatrix,
  fetchTemplate,
  generateVariants,
  previewVariants,
  productErrorMessage,
  type GenerateResult,
  type MatrixSpace,
  type PreviewCombination,
  type TemplateDetail,
} from "@/lib/product";

const STATUS_ACTIVE = "فعال";
const STATUS_INACTIVE = "غیرفعال";

function statusBadge(active: boolean) {
  return active ? (
    <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">
      {STATUS_ACTIVE}
    </span>
  ) : (
    <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">
      {STATUS_INACTIVE}
    </span>
  );
}

/** Persian reason for a skipped combination. */
function skipReason(reason: string): string {
  if (reason === "VARIANT_COMBINATION_EXISTS") return "ترکیب تکراری";
  if (reason === "VARIANT_SKU_COLLISION") return "برخورد SKU";
  if (reason.startsWith("Attribute")) return "ویژگی مجاز نیست";
  if (reason.startsWith("Value")) return "مقدار نامعتبر";
  if (reason.startsWith("Duplicate")) return "ویژگی تکراری در ترکیب";
  return reason;
}

export function VariantsTab({
  template,
  onChanged,
}: {
  template: TemplateDetail;
  onChanged: (template: TemplateDetail) => void;
}) {
  const variantAttributes = useMemo(
    () => template.attributes.filter((entry) => entry.createsVariants),
    [template.attributes],
  );

  const [selected, setSelected] = useState<Record<string, Set<string>>>({});
  const [preview, setPreview] = useState<PreviewCombination[] | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [previewing, setPreviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<(GenerateResult & { skippedLabels: string[] }) | null>(null);

  const [matrix, setMatrix] = useState<{ columns: MatrixSpace[]; rows: MatrixSpace[] } | null>(null);

  // Lookups for attribute/value display names.
  const attributeName = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of template.attributes) map.set(entry.attributeId, entry.attribute.nameFa);
    return map;
  }, [template.attributes]);
  const valueName = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of template.attributes) {
      for (const value of entry.attribute.values) map.set(value.id, value.valueFa);
    }
    return map;
  }, [template.attributes]);

  // Reset the generator when the variant space changes.
  useEffect(() => {
    setSelected({});
    setPreview(null);
    setChecked(new Set());
    setReport(null);
  }, [variantAttributes]);

  const loadMatrix = useCallback(async () => {
    try {
      const result = await fetchMatrix(template.id);
      setMatrix({ columns: result.columns, rows: result.rows });
    } catch {
      setMatrix(null);
    }
  }, [template.id]);

  useEffect(() => {
    void loadMatrix();
  }, [loadMatrix]);

  function toggleAttribute(attributeId: string) {
    setSelected((current) => {
      const next = { ...current };
      if (next[attributeId]) delete next[attributeId];
      else next[attributeId] = new Set();
      return next;
    });
    setPreview(null);
    setChecked(new Set());
  }

  function toggleValue(attributeId: string, valueId: string) {
    setSelected((current) => {
      const next = { ...current };
      const set = new Set(next[attributeId] ?? []);
      if (set.has(valueId)) set.delete(valueId);
      else set.add(valueId);
      next[attributeId] = set;
      return next;
    });
    setPreview(null);
    setChecked(new Set());
  }

  const selectionCount = Object.values(selected).reduce(
    (sum, set) => sum + set.size,
    0,
  );

  async function handlePreview() {
    setError(null);
    const selections = Object.entries(selected)
      .filter(([, valueIds]) => valueIds.size > 0)
      .map(([attributeId, valueIds]) => ({ attributeId, valueIds: Array.from(valueIds) }));
    if (selections.length === 0) {
      setError("حداقل یک ویژگی و یک مقدار انتخاب کنید.");
      return;
    }
    setPreviewing(true);
    try {
      const result = await previewVariants(template.id, selections);
      setPreview(result.combinations);
      setChecked(new Set(result.combinations.map((_, index) => index).filter((index) => !result.combinations[index].existsAlready)));
      setReport(null);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setPreviewing(false);
    }
  }

  async function handleGenerate() {
    if (!preview || checked.size === 0 || generating) return;
    setGenerating(true);
    setError(null);
    try {
      const combinations = Array.from(checked).map((index) => ({
        selections: preview[index].combination.map((pair) => ({
          attributeId: pair.attributeId,
          valueId: pair.valueId,
        })),
      }));
      const result = await generateVariants(template.id, combinations);
      setReport({
        ...result,
        skippedLabels: result.skipped.map(
          (entry) =>
            `${entry.combination
              .map((pair) => valueName.get(pair.valueId) ?? pair.valueId)
              .join(" × ")} — ${skipReason(entry.reason)}`,
        ),
      });
      setPreview(null);
      setChecked(new Set());
      setSelected({});
      onChanged(await fetchTemplate(template.id));
      await loadMatrix();
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Variants table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">
            محصولات (Variants) — {faDigits(template.variants.length)} ردیف
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="فهرست variants محصول">
            <thead>
              <tr className="bg-white text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-start">SKU</th>
                <th scope="col" className="px-4 py-2 text-start">نام</th>
                <th scope="col" className="px-4 py-2 text-start">ترکیب</th>
                <th scope="col" className="px-4 py-2 text-start">وزن واحد</th>
                <th scope="col" className="px-4 py-2 text-center">وضعیت</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {template.variants.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-slate-400">
                    هنوز variantی ایجاد نشده است. از بخش «تولید ترکیب‌ها» استفاده کنید.
                  </td>
                </tr>
              ) : (
                template.variants.map((variant) => (
                  <tr key={variant.id} className="text-slate-700 hover:bg-slate-50">
                    <td className="px-4 py-2" dir="ltr">{variant.sku}</td>
                    <td className="px-4 py-2 font-medium text-slate-800">{variant.nameFa}</td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {variant.values.length > 0
                        ? variant.values.map((value) => value.attributeValue.valueFa).join(" × ")
                        : "—"}
                    </td>
                    <td className="px-4 py-2 tabular-nums" dir="ltr">
                      {variant.weightPerUnit !== null ? faDigits(Number(variant.weightPerUnit)) : "—"}
                    </td>
                    <td className="px-4 py-2 text-center">{statusBadge(variant.active)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Matrix generator */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold text-slate-800">تولید ترکیب‌ها (ماتریس)</h3>
        <p className="mt-1 text-xs text-slate-500">
          ویژگی‌های تعریف‌کننده variant را انتخاب کنید، برای هر ویژگی مقادیر دلخواه را علامت بزنید
          و «پیش‌نمایش» بگیرید؛ سپس ردیف‌های موردنیاز را انتخاب و «ایجاد» کنید.
        </p>

        {variantAttributes.length === 0 ? (
          <p className="mt-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
            هنوز هیچ ویژگیِ تعریف‌کننده variantی برای این محصول ثبت نشده است. از تب «ویژگی‌ها»
            ویژگی اضافه کنید و گزینه «تعریف variant» را فعال کنید.
          </p>
        ) : (
          <>
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {variantAttributes.map((entry) => {
                const isSelected = Boolean(selected[entry.attributeId]);
                return (
                  <div key={entry.attributeId} className="rounded-lg border border-slate-200 p-3">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleAttribute(entry.attributeId)}
                        className="h-4 w-4 accent-primary-600"
                        aria-label={`انتخاب ویژگی ${entry.attribute.nameFa}`}
                      />
                      {entry.attribute.nameFa}
                      <span dir="ltr" className="text-[11px] text-slate-400">{entry.attribute.code}</span>
                    </label>
                    {isSelected && (
                      <div className="mt-2 flex flex-wrap gap-2 border-t border-slate-100 pt-2">
                        {entry.attribute.values.map((value) => {
                          const active = selected[entry.attributeId]?.has(value.id) ?? false;
                          return (
                            <label
                              key={value.id}
                              className={`flex cursor-pointer items-center gap-1.5 rounded border px-2 py-1 text-xs transition-colors ${
                                active
                                  ? "border-primary-300 bg-primary-50 text-primary-800"
                                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={active}
                                onChange={() => toggleValue(entry.attributeId, value.id)}
                                className="h-3.5 w-3.5 accent-primary-600"
                                aria-label={`مقدار ${value.valueFa}`}
                              />
                              {value.valueFa}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => void handlePreview()} disabled={previewing || selectionCount === 0}>
                {previewing ? "در حال پیش‌نمایش…" : "پیش‌نمایش"}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void handleGenerate()}
                disabled={generating || !preview || checked.size === 0}
              >
                {generating ? "در حال ایجاد…" : `ایجاد (${faDigits(checked.size)} ردیف)`}
              </Button>
              {selectionCount === 0 && (
                <span className="text-xs text-slate-400">ابتدا ویژگی‌ها و مقادیر را انتخاب کنید.</span>
              )}
            </div>

            {error && (
              <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
                {error}
              </div>
            )}

            {/* Preview table */}
            {preview && (
              <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
                <div className="overflow-x-auto">
                  <table className="w-full min-w-max border-collapse text-sm" aria-label="پیش‌نمایش ترکیب‌ها">
                    <thead>
                      <tr className="bg-slate-50 text-xs text-slate-500">
                        <th scope="col" className="px-3 py-2 text-center">انتخاب</th>
                        {[...Object.keys(selected)].map((attributeId) => (
                          <th key={attributeId} scope="col" className="px-3 py-2 text-start">
                            {attributeName.get(attributeId) ?? attributeId}
                          </th>
                        ))}
                        <th scope="col" className="px-3 py-2 text-start">SKU پیشنهادی</th>
                        <th scope="col" className="px-3 py-2 text-center">وضعیت</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {preview.map((combination, index) => (
                        <tr key={index} className={combination.existsAlready ? "bg-slate-50 text-slate-400" : "text-slate-700"}>
                          <td className="px-3 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={checked.has(index)}
                              disabled={combination.existsAlready}
                              onChange={() =>
                                setChecked((current) => {
                                  const next = new Set(current);
                                  if (next.has(index)) next.delete(index);
                                  else next.add(index);
                                  return next;
                                })
                              }
                              aria-label={`انتخاب ترکیب ${combination.skuSuggestion}`}
                              className="h-4 w-4 accent-primary-600"
                            />
                          </td>
                          {Object.keys(selected).map((attributeId) => {
                            const pair = combination.combination.find((item) => item.attributeId === attributeId);
                            return (
                              <td key={attributeId} className="px-3 py-1.5">
                                {pair ? valueName.get(pair.valueId) ?? pair.valueCode : "—"}
                              </td>
                            );
                          })}
                          <td className="px-3 py-1.5" dir="ltr">{combination.skuSuggestion}</td>
                          <td className="px-3 py-1.5 text-center text-[11px]">
                            {combination.existsAlready ? (
                              <span className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-amber-700">
                                از قبل موجود
                              </span>
                            ) : (
                              <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-emerald-700">
                                جدید
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Generation report */}
            {report && (
              <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4" role="status">
                <p className="text-sm font-bold text-emerald-700">
                  {faDigits(report.created.length)} variant ایجاد شد.
                </p>
                {report.skippedLabels.length > 0 && (
                  <div className="mt-2">
                    <p className="text-xs font-medium text-amber-700">
                      {faDigits(report.skipped.length)} ترکیب رد شد:
                    </p>
                    <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-slate-500">
                      {report.skippedLabels.map((label, index) => (
                        <li key={index}>{label}</li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.created.length > 0 && (
                  <p className="mt-2 text-xs text-slate-500" dir="ltr">
                    {report.created.map((item) => item.sku).join("، ")}
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Existing matrix (phase-4 view) */}
      {matrix && (matrix.columns.length > 0 || matrix.rows.length > 0) && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-bold text-slate-800">نمای ماتریس موجود</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm" aria-label="ماتریس variants موجود">
              <thead>
                <tr className="bg-slate-50 text-xs text-slate-500">
                  <th scope="col" className="px-3 py-2 text-start">
                    {matrix.rows.length > 0 ? matrix.rows.map((row) => row.nameFa).join(" / ") : ""}
                  </th>
                  {matrix.columns[0]?.values.map((value) => (
                    <th key={value.id} scope="col" className="px-3 py-2 text-start">{value.valueFa}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(matrix.rows.length > 0
                  ? matrix.rows[0].values.map((rowValue) => [rowValue])
                  : [[]]
                ).map((rowValues, rowIndex) => (
                  <tr key={rowIndex} className="text-slate-700">
                    <td className="px-3 py-1.5 font-medium">
                      {rowValues.map((value) => value.valueFa).join(" — ") || "—"}
                    </td>
                    {matrix.columns[0]?.values.map((columnValue) => {
                      const hit = template.variants.find((variant) => {
                        const ids = variant.values.map((value) => value.attributeValueId);
                        return rowValues.every((value) => ids.includes(value.id)) && ids.includes(columnValue.id);
                      });
                      return (
                        <td key={columnValue.id} className="px-3 py-1.5">
                          {hit ? (
                            <span dir="ltr" className="text-xs text-primary-700">{hit.sku}</span>
                          ) : (
                            <span className="text-xs text-slate-300">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
