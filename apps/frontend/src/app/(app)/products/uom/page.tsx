"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductsNav } from "@/components/products/nav";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits } from "@/lib/format";
import {
  convertUom,
  createUom,
  createUomCategory,
  fetchUomCategories,
  parseDecimalInput,
  productErrorMessage,
  updateUom,
  updateUomCategory,
  type UomCategoryDto,
} from "@/lib/product";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

type CategoryEditor = {
  kind: "category-create" | "category-edit";
  id: string | null;
  code: string;
  nameFa: string;
  nameEn: string;
};

type UomEditor = {
  kind: "uom-create" | "uom-edit";
  id: string | null;
  categoryId: string;
  symbol: string;
  nameFa: string;
  nameEn: string;
  conversionRatio: string;
  isBaseUnit: boolean;
  active: boolean;
};

type Editor = CategoryEditor | UomEditor | null;

export default function UomPage() {
  const [categories, setCategories] = useState<UomCategoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editor, setEditor] = useState<Editor>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [convertValue, setConvertValue] = useState("");
  const [fromUomId, setFromUomId] = useState("");
  const [toUomId, setToUomId] = useState("");
  const [convertResult, setConvertResult] = useState<string | null>(null);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);

  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const allUoms = useMemo(() => categories.flatMap((category) => category.uoms), [categories]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchUomCategories();
      setCategories(items);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEscClose(Boolean(editor), () => {
    setEditor(null);
    setFormError(null);
  }, openButtonRef);

  useEffect(() => {
    if (editor) firstFieldRef.current?.focus();
  }, [editor]);

  // Keep the converter selects valid when data reloads.
  useEffect(() => {
    if (fromUomId && !allUoms.some((uom) => uom.id === fromUomId)) setFromUomId("");
    if (toUomId && !allUoms.some((uom) => uom.id === toUomId)) setToUomId("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allUoms]);

  function openCategoryCreate() {
    setFormError(null);
    setEditor({ kind: "category-create", id: null, code: "", nameFa: "", nameEn: "" });
  }

  function openCategoryEdit(category: UomCategoryDto) {
    setFormError(null);
    setEditor({
      kind: "category-edit",
      id: category.id,
      code: category.code,
      nameFa: category.nameFa,
      nameEn: category.nameEn ?? "",
    });
  }

  function openUomCreate(categoryId: string) {
    setFormError(null);
    setEditor({
      kind: "uom-create",
      id: null,
      categoryId,
      symbol: "",
      nameFa: "",
      nameEn: "",
      conversionRatio: "1",
      isBaseUnit: false,
      active: true,
    });
  }

  function openUomEdit(categoryId: string, uom: UomCategoryDto["uoms"][number]) {
    setFormError(null);
    setEditor({
      kind: "uom-edit",
      id: uom.id,
      categoryId,
      symbol: uom.symbol,
      nameFa: uom.nameFa,
      nameEn: uom.nameEn ?? "",
      conversionRatio: uom.conversionRatio,
      isBaseUnit: uom.isBaseUnit,
      active: uom.active,
    });
  }

  async function save() {
    if (!editor || saving) return;
    setFormError(null);
    if (editor.kind === "category-create" || editor.kind === "category-edit") {
      if (!editor.nameFa.trim()) {
        setFormError("نام فارسی دسته الزامی است.");
        return;
      }
      if (editor.kind === "category-create" && !editor.code.trim()) {
        setFormError("کد دسته الزامی است.");
        return;
      }
      setSaving(true);
      try {
        if (editor.kind === "category-create") {
          await createUomCategory({
            code: editor.code.trim(),
            nameFa: editor.nameFa.trim(),
            nameEn: editor.nameEn.trim() || undefined,
          });
        } else if (editor.id) {
          await updateUomCategory(editor.id, {
            nameFa: editor.nameFa.trim(),
            nameEn: editor.nameEn.trim() || undefined,
          });
        }
        setEditor(null);
        setNotice("ذخیره شد.");
        await load();
        return;
      } catch (err) {
        setFormError(productErrorMessage(err));
        return;
      } finally {
        setSaving(false);
      }
    }

    // UOM editor
    if (editor.kind !== "uom-create" && editor.kind !== "uom-edit") return;
    if (!editor.nameFa.trim() || !editor.symbol.trim()) {
      setFormError("نام فارسی و نماد واحد الزامی است.");
      return;
    }
    const ratio = parseDecimalInput(editor.conversionRatio);
    if (!ratio || Number(ratio) <= 0) {
      setFormError("نسبت تبدیل باید یک عدد مثبت باشد.");
      return;
    }
    setSaving(true);
    try {
      if (editor.kind === "uom-create") {
        await createUom({
          categoryId: editor.categoryId,
          nameFa: editor.nameFa.trim(),
          nameEn: editor.nameEn.trim() || undefined,
          symbol: editor.symbol.trim(),
          conversionRatio: ratio,
          isBaseUnit: editor.isBaseUnit,
          active: editor.active,
        });
      } else if (editor.id) {
        await updateUom(editor.id, {
          nameFa: editor.nameFa.trim(),
          nameEn: editor.nameEn.trim() || undefined,
          conversionRatio: ratio,
          isBaseUnit: editor.isBaseUnit,
          active: editor.active,
        });
      }
      setEditor(null);
      setNotice("ذخیره شد.");
      await load();
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!editor) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, saving]);

  async function handleConvert(event: FormEvent) {
    event.preventDefault();
    setConvertError(null);
    setConvertResult(null);
    const value = parseDecimalInput(convertValue);
    if (!value || !fromUomId || !toUomId) {
      setConvertError("مقدار و هر دو واحد را انتخاب کنید.");
      return;
    }
    setConverting(true);
    try {
      const result = await convertUom({ value, fromUomId, toUomId });
      setConvertResult(
        `${faDigits(Number(result.value))} ${result.toSymbol} (از ${result.fromSymbol})`,
      );
    } catch (err) {
      setConvertError(productErrorMessage(err));
    } finally {
      setConverting(false);
    }
  }

  const uomSelectOptions = useMemo(
    () =>
      categories.flatMap((category) =>
        category.uoms.map((uom) => ({
          id: uom.id,
          label: `${uom.nameFa} (${uom.symbol}) — ${category.nameFa}`,
        })),
      ),
    [categories],
  );

  const selectClass =
    "h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20";

  return (
    <div className="space-y-4">
      <ProductsNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">واحدهای اندازه‌گیری</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            دسته‌ها، واحدها، واحد پایه هر دسته و ماشین‌حساب تبدیل
          </p>
        </div>
        <Button ref={openButtonRef} size="sm" onClick={openCategoryCreate} aria-label="ایجاد دسته واحد جدید">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          دسته جدید
        </Button>
      </div>

      {notice && !editor && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Inline editor */}
      {editor && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-bold text-slate-800">
            {editor.kind === "category-create" && "دسته واحد جدید"}
            {editor.kind === "category-edit" && "ویرایش دسته واحد"}
            {editor.kind === "uom-create" && "واحد جدید"}
            {editor.kind === "uom-edit" && "ویرایش واحد"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {"code" in editor ? (
              <>
                <div>
                  <label htmlFor="uc-code" className={fieldLabel}>
                    کد {editor.kind === "category-create" ? "*" : "(غیرقابل تغییر)"}
                  </label>
                  <Input
                    ref={firstFieldRef}
                    id="uc-code"
                    dir="ltr"
                    disabled={editor.kind === "category-edit"}
                    value={editor.code}
                    onChange={(event) =>
                      setEditor({ ...editor, code: event.target.value })
                    }
                  />
                </div>
                <div>
                  <label htmlFor="uc-nameFa" className={fieldLabel}>نام فارسی *</label>
                  <Input
                    id="uc-nameFa"
                    value={editor.nameFa}
                    onChange={(event) => setEditor({ ...editor, nameFa: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="uc-nameEn" className={fieldLabel}>نام لاتین</label>
                  <Input
                    id="uc-nameEn"
                    dir="ltr"
                    value={editor.nameEn}
                    onChange={(event) => setEditor({ ...editor, nameEn: event.target.value })}
                  />
                </div>
              </>
            ) : (
              <>
                <div>
                  <label htmlFor="u-category" className={fieldLabel}>دسته</label>
                  <select
                    id="u-category"
                    value={editor.categoryId}
                    disabled={editor.kind === "uom-edit"}
                    onChange={(event) => setEditor({ ...editor, categoryId: event.target.value })}
                    className={`${selectClass} ${editor.kind === "uom-edit" ? "bg-slate-50 text-slate-400" : ""}`}
                  >
                    {categories.map((category) => (
                      <option key={category.id} value={category.id}>
                        {category.nameFa}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="u-symbol" className={fieldLabel}>
                    نماد {editor.kind === "uom-create" ? "*" : "(غیرقابل تغییر)"}
                  </label>
                  <Input
                    ref={firstFieldRef}
                    id="u-symbol"
                    dir="ltr"
                    disabled={editor.kind === "uom-edit"}
                    value={editor.symbol}
                    onChange={(event) => setEditor({ ...editor, symbol: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="u-nameFa" className={fieldLabel}>نام فارسی *</label>
                  <Input
                    id="u-nameFa"
                    value={editor.nameFa}
                    onChange={(event) => setEditor({ ...editor, nameFa: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="u-nameEn" className={fieldLabel}>نام لاتین</label>
                  <Input
                    id="u-nameEn"
                    dir="ltr"
                    value={editor.nameEn}
                    onChange={(event) => setEditor({ ...editor, nameEn: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="u-ratio" className={fieldLabel}>نسبت تبدیل به واحد پایه *</label>
                  <Input
                    id="u-ratio"
                    dir="ltr"
                    inputMode="decimal"
                    value={editor.conversionRatio}
                    onChange={(event) => setEditor({ ...editor, conversionRatio: event.target.value })}
                  />
                </div>
                <div className="flex items-end gap-6 pb-1">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={editor.isBaseUnit}
                      onChange={(event) => setEditor({ ...editor, isBaseUnit: event.target.checked })}
                      className="h-4 w-4 accent-primary-600"
                    />
                    واحد پایه دسته
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                    <input
                      type="checkbox"
                      checked={editor.active}
                      onChange={(event) => setEditor({ ...editor, active: event.target.checked })}
                      className="h-4 w-4 accent-primary-600"
                    />
                    فعال
                  </label>
                </div>
              </>
            )}
          </div>

          {formError && (
            <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditor(null);
                setFormError(null);
                openButtonRef.current?.focus();
              }}
              disabled={saving}
            >
              انصراف (Esc)
            </Button>
          </div>
        </div>
      )}

      {/* Converter card */}
      <form
        onSubmit={handleConvert}
        className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
        aria-label="ماشین‌حساب تبدیل واحدها"
      >
        <h3 className="mb-4 text-sm font-bold text-slate-800">تبدیل واحد</h3>
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
          <div>
            <label htmlFor="conv-value" className={fieldLabel}>مقدار</label>
            <Input
              id="conv-value"
              dir="ltr"
              inputMode="decimal"
              value={convertValue}
              onChange={(event) => setConvertValue(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="conv-from" className={fieldLabel}>از واحد</label>
            <select id="conv-from" value={fromUomId} onChange={(event) => setFromUomId(event.target.value)} className={selectClass}>
              <option value="">انتخاب کنید…</option>
              {uomSelectOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="conv-to" className={fieldLabel}>به واحد</label>
            <select id="conv-to" value={toUomId} onChange={(event) => setToUomId(event.target.value)} className={selectClass}>
              <option value="">انتخاب کنید…</option>
              {uomSelectOptions.map((option) => (
                <option key={option.id} value={option.id}>{option.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Button type="submit" disabled={converting}>
              {converting ? "در حال تبدیل…" : "تبدیل"}
            </Button>
          </div>
        </div>
        {convertResult && (
          <p className="mt-3 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800" role="status">
            نتیجه: {convertResult}
          </p>
        )}
        {convertError && (
          <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700" role="alert">
            {convertError}
          </p>
        )}
      </form>

      {/* Categories + units */}
      {loading ? (
        <p className="py-8 text-center text-sm text-slate-400">در حال بارگذاری…</p>
      ) : categories.length === 0 ? (
        <p className="rounded-xl border border-slate-200 bg-white py-10 text-center text-sm text-slate-400 shadow-sm">
          هنوز دسته واحدی ثبت نشده است.
        </p>
      ) : (
        <div className="space-y-4">
          {categories.map((category) => (
            <div key={category.id} className="rounded-xl border border-slate-200 bg-white shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">
                    <span dir="ltr" className="me-2 text-[11px] tabular-nums text-slate-400">{category.code}</span>
                    {category.nameFa}
                    {category.nameEn && (
                      <span dir="ltr" className="ms-2 text-[11px] text-slate-400">{category.nameEn}</span>
                    )}
                  </h3>
                </div>
                <div className="flex items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => openCategoryEdit(category)}>
                    ویرایش دسته
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openUomCreate(category.id)}>
                    واحد جدید
                  </Button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-max border-collapse text-sm" aria-label={`واحدهای دسته ${category.nameFa}`}>
                  <thead>
                    <tr className="bg-slate-50 text-xs text-slate-500">
                      <th scope="col" className="px-4 py-2 text-start">واحد پایه</th>
                      <th scope="col" className="px-4 py-2 text-start">نماد</th>
                      <th scope="col" className="px-4 py-2 text-start">نام</th>
                      <th scope="col" className="px-4 py-2 text-start">نسبت تبدیل</th>
                      <th scope="col" className="px-4 py-2 text-start">وضعیت</th>
                      <th scope="col" className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {category.uoms.map((uom) => (
                      <tr key={uom.id} className="text-slate-700">
                        <td className="px-4 py-2">
                          <input
                            type="radio"
                            name={`base-unit-${category.id}`}
                            checked={uom.isBaseUnit}
                            onChange={() => openUomEdit(category.id, uom)}
                            disabled={!uom.isBaseUnit}
                            aria-label={`تعیین ${uom.nameFa} به عنوان واحد پایه`}
                            title={uom.isBaseUnit ? "واحد پایه این دسته" : "برای تغییر، ویرایش واحد و انتخاب «واحد پایه»"}
                            className="h-4 w-4 accent-primary-600"
                          />
                        </td>
                        <td className="px-4 py-2" dir="ltr">{uom.symbol}</td>
                        <td className="px-4 py-2">
                          {uom.nameFa}
                          {uom.nameEn && (
                            <span dir="ltr" className="ms-2 text-[11px] text-slate-400">{uom.nameEn}</span>
                          )}
                        </td>
                        <td className="px-4 py-2 tabular-nums" dir="ltr">{faDigits(Number(uom.conversionRatio))}</td>
                        <td className="px-4 py-2">
                          {uom.active ? (
                            <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">فعال</span>
                          ) : (
                            <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">غیرفعال</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-end">
                          <Button variant="ghost" size="sm" onClick={() => openUomEdit(category.id, uom)}>
                            ویرایش
                          </Button>
                        </td>
                      </tr>
                    ))}
                    {category.uoms.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-6 text-center text-xs text-slate-400">
                          برای این دسته هنوز واحدی ثبت نشده است.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
