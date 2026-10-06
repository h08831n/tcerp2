"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductsNav } from "@/components/products/nav";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits } from "@/lib/format";
import {
  createAttribute,
  createAttributeValue,
  fetchAttributes,
  parseDecimalInput,
  productErrorMessage,
  updateAttribute,
  updateAttributeValue,
  type AttributeDto,
} from "@/lib/product";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

interface AttributeEditor {
  mode: "create" | "edit";
  id: string | null;
  code: string;
  nameFa: string;
  nameEn: string;
  displayOrder: string;
  active: boolean;
}

interface ValueEditor {
  mode: "create" | "edit";
  id: string | null;
  attributeId: string;
  code: string;
  valueFa: string;
  valueEn: string;
  numericValue: string;
  displayOrder: string;
}

export default function AttributesPage() {
  const [attributes, setAttributes] = useState<AttributeDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [attributeEditor, setAttributeEditor] = useState<AttributeEditor | null>(null);
  const [valueEditor, setValueEditor] = useState<ValueEditor | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const valuesButtonRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchAttributes(showInactive ? {} : { active: true });
      setAttributes(result.items);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [showInactive]);

  useEffect(() => {
    void load();
  }, [load]);

  const anyEditor = Boolean(attributeEditor || valueEditor);
  useEscClose(anyEditor, () => {
    setAttributeEditor(null);
    setValueEditor(null);
    setFormError(null);
  }, attributeEditor ? openButtonRef : valuesButtonRef);

  useEffect(() => {
    if (anyEditor) firstFieldRef.current?.focus();
  }, [anyEditor]);

  function openAttributeCreate() {
    setFormError(null);
    setAttributeEditor({ mode: "create", id: null, code: "", nameFa: "", nameEn: "", displayOrder: "0", active: true });
  }

  function openAttributeEdit(attribute: AttributeDto) {
    setFormError(null);
    setAttributeEditor({
      mode: "edit",
      id: attribute.id,
      code: attribute.code,
      nameFa: attribute.nameFa,
      nameEn: attribute.nameEn ?? "",
      displayOrder: String(attribute.displayOrder),
      active: attribute.active,
    });
  }

  function openValueCreate(attributeId: string) {
    setFormError(null);
    setValueEditor({
      mode: "create",
      id: null,
      attributeId,
      code: "",
      valueFa: "",
      valueEn: "",
      numericValue: "",
      displayOrder: "0",
    });
  }

  async function saveAttribute() {
    if (!attributeEditor || saving) return;
    if (attributeEditor.mode === "create" && !attributeEditor.code.trim()) {
      setFormError("کد ویژگی الزامی است.");
      return;
    }
    if (!attributeEditor.nameFa.trim()) {
      setFormError("نام فارسی ویژگی الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        nameFa: attributeEditor.nameFa.trim(),
        nameEn: attributeEditor.nameEn.trim() || undefined,
        displayOrder: Number(attributeEditor.displayOrder) || 0,
        active: attributeEditor.active,
      };
      if (attributeEditor.mode === "create") {
        await createAttribute({ ...body, code: attributeEditor.code.trim() });
      } else if (attributeEditor.id) {
        await updateAttribute(attributeEditor.id, body);
      }
      setAttributeEditor(null);
      setNotice("ذخیره شد.");
      await load();
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveValue() {
    if (!valueEditor || saving) return;
    if (valueEditor.mode === "create" && !valueEditor.code.trim()) {
      setFormError("کد مقدار الزامی است.");
      return;
    }
    if (!valueEditor.valueFa.trim()) {
      setFormError("مقدار فارسی الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const numeric = parseDecimalInput(valueEditor.numericValue);
      if (valueEditor.mode === "create") {
        await createAttributeValue({
          attributeId: valueEditor.attributeId,
          code: valueEditor.code.trim(),
          valueFa: valueEditor.valueFa.trim(),
          valueEn: valueEditor.valueEn.trim() || undefined,
          numericValue: numeric || undefined,
          displayOrder: Number(valueEditor.displayOrder) || 0,
        });
      } else if (valueEditor.id) {
        await updateAttributeValue(valueEditor.id, {
          valueFa: valueEditor.valueFa.trim(),
          valueEn: valueEditor.valueEn.trim() || undefined,
          numericValue: numeric || undefined,
          displayOrder: Number(valueEditor.displayOrder) || 0,
        });
      }
      setValueEditor(null);
      setNotice("ذخیره شد.");
      await load();
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!attributeEditor) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveAttribute();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attributeEditor, saving]);

  useEffect(() => {
    if (!valueEditor) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveValue();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueEditor, saving]);

  const rows = useMemo(
    () => attributes.filter((attribute) => showInactive || attribute.active),
    [attributes, showInactive],
  );

  const expandedAttribute = rows.find((attribute) => attribute.id === expandedId) ?? null;

  return (
    <div className="space-y-4">
      <ProductsNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">ویژگی‌ها</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            ویژگی‌های پویا و مقادیر آن‌ها — پایه تعریف variants محصول
          </p>
        </div>
        <Button ref={openButtonRef} size="sm" onClick={openAttributeCreate} aria-label="ایجاد ویژگی جدید">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          ویژگی جدید
        </Button>
      </div>

      {notice && !anyEditor && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {error && !anyEditor && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Attribute editor */}
      {attributeEditor && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-bold text-slate-800">
            {attributeEditor.mode === "create" ? "ویژگی جدید" : "ویرایش ویژگی"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="attr-code" className={fieldLabel}>
                کد {attributeEditor.mode === "create" ? "*" : "(غیرقابل تغییر)"}
              </label>
              <Input
                ref={firstFieldRef}
                id="attr-code"
                dir="ltr"
                disabled={attributeEditor.mode === "edit"}
                value={attributeEditor.code}
                onChange={(event) => setAttributeEditor({ ...attributeEditor, code: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="attr-nameFa" className={fieldLabel}>نام فارسی *</label>
              <Input
                id="attr-nameFa"
                value={attributeEditor.nameFa}
                onChange={(event) => setAttributeEditor({ ...attributeEditor, nameFa: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="attr-nameEn" className={fieldLabel}>نام لاتین</label>
              <Input
                id="attr-nameEn"
                dir="ltr"
                value={attributeEditor.nameEn}
                onChange={(event) => setAttributeEditor({ ...attributeEditor, nameEn: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="attr-order" className={fieldLabel}>ترتیب نمایش</label>
              <Input
                id="attr-order"
                dir="ltr"
                inputMode="numeric"
                value={attributeEditor.displayOrder}
                onChange={(event) => setAttributeEditor({ ...attributeEditor, displayOrder: event.target.value })}
              />
            </div>
            <div className="flex items-end pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={attributeEditor.active}
                  onChange={(event) => setAttributeEditor({ ...attributeEditor, active: event.target.checked })}
                  className="h-4 w-4 accent-primary-600"
                />
                فعال
              </label>
            </div>
          </div>
          {formError && (
            <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
            <Button onClick={() => void saveAttribute()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setAttributeEditor(null);
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

      {/* Value editor */}
      {valueEditor && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-bold text-slate-800">
            {valueEditor.mode === "create" ? "مقدار جدید" : "ویرایش مقدار"}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="val-code" className={fieldLabel}>
                کد {valueEditor.mode === "create" ? "*" : "(غیرقابل تغییر)"}
              </label>
              <Input
                ref={firstFieldRef}
                id="val-code"
                dir="ltr"
                disabled={valueEditor.mode === "edit"}
                value={valueEditor.code}
                onChange={(event) => setValueEditor({ ...valueEditor, code: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="val-fa" className={fieldLabel}>مقدار فارسی *</label>
              <Input
                id="val-fa"
                value={valueEditor.valueFa}
                onChange={(event) => setValueEditor({ ...valueEditor, valueFa: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="val-en" className={fieldLabel}>مقدار لاتین</label>
              <Input
                id="val-en"
                dir="ltr"
                value={valueEditor.valueEn}
                onChange={(event) => setValueEditor({ ...valueEditor, valueEn: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="val-numeric" className={fieldLabel}>مقدار عددی (اختیاری)</label>
              <Input
                id="val-numeric"
                dir="ltr"
                inputMode="decimal"
                value={valueEditor.numericValue}
                onChange={(event) => setValueEditor({ ...valueEditor, numericValue: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="val-order" className={fieldLabel}>ترتیب نمایش</label>
              <Input
                id="val-order"
                dir="ltr"
                inputMode="numeric"
                value={valueEditor.displayOrder}
                onChange={(event) => setValueEditor({ ...valueEditor, displayOrder: event.target.value })}
              />
            </div>
          </div>
          {formError && (
            <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}
          <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
            <Button onClick={() => void saveValue()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setValueEditor(null);
                setFormError(null);
                valuesButtonRef.current?.focus();
              }}
              disabled={saving}
            >
              انصراف (Esc)
            </Button>
          </div>
        </div>
      )}

      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-slate-600">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(event) => setShowInactive(event.target.checked)}
          className="h-4 w-4 accent-primary-600"
        />
        نمایش غیرفعال‌ها
      </label>

      {/* Attributes table with expandable values */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="فهرست ویژگی‌ها">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-start">کد</th>
                <th scope="col" className="px-4 py-2 text-start">نام فارسی</th>
                <th scope="col" className="px-4 py-2 text-start">نام لاتین</th>
                <th scope="col" className="px-4 py-2 text-center">ترتیب</th>
                <th scope="col" className="px-4 py-2 text-center">تعداد مقادیر</th>
                <th scope="col" className="px-4 py-2 text-center">وضعیت</th>
                <th scope="col" className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-400">در حال بارگذاری…</td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-sm text-slate-400">
                    ویژگی‌ای ثبت نشده است. با دکمه «ویژگی جدید» اولین ویژگی را بسازید.
                  </td>
                </tr>
              ) : (
                rows.map((attribute) => (
                  <tr key={attribute.id} className="text-slate-700 hover:bg-slate-50">
                    <td className="px-4 py-2" dir="ltr">{attribute.code}</td>
                    <td className="px-4 py-2 font-medium text-slate-800">{attribute.nameFa}</td>
                    <td className="px-4 py-2 text-slate-500" dir="ltr">{attribute.nameEn ?? "—"}</td>
                    <td className="px-4 py-2 text-center tabular-nums">{faDigits(attribute.displayOrder)}</td>
                    <td className="px-4 py-2 text-center tabular-nums">{faDigits(attribute.values.length)}</td>
                    <td className="px-4 py-2 text-center">
                      {attribute.active ? (
                        <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] text-emerald-700">فعال</span>
                      ) : (
                        <span className="rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] text-red-600">غیرفعال</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-end">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          ref={expandedId === attribute.id ? valuesButtonRef : undefined}
                          variant="ghost"
                          size="sm"
                          onClick={() => setExpandedId(expandedId === attribute.id ? null : attribute.id)}
                          aria-expanded={expandedId === attribute.id}
                        >
                          {expandedId === attribute.id ? "بستن مقادیر" : "مقادیر"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openAttributeEdit(attribute)}>
                          ویرایش
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Values panel for the expanded attribute */}
      {expandedAttribute && (
        <div className="rounded-xl border border-primary-200 bg-primary-50/40 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-bold text-slate-800">
              مقادیر ویژگی «{expandedAttribute.nameFa}»
              <span dir="ltr" className="ms-2 text-[11px] text-slate-400">{expandedAttribute.code}</span>
            </h3>
            <Button size="sm" variant="secondary" onClick={() => openValueCreate(expandedAttribute.id)}>
              مقدار جدید
            </Button>
          </div>
          {expandedAttribute.values.length === 0 ? (
            <p className="py-4 text-center text-xs text-slate-400">
              برای این ویژگی مقداری ثبت نشده است.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
              <table className="w-full min-w-max border-collapse text-sm" aria-label={`مقادیر ویژگی ${expandedAttribute.nameFa}`}>
                <thead>
                  <tr className="bg-slate-50 text-xs text-slate-500">
                    <th scope="col" className="px-3 py-2 text-start">کد</th>
                    <th scope="col" className="px-3 py-2 text-start">مقدار فارسی</th>
                    <th scope="col" className="px-3 py-2 text-start">مقدار لاتین</th>
                    <th scope="col" className="px-3 py-2 text-start">مقدار عددی</th>
                    <th scope="col" className="px-3 py-2 text-center">ترتیب</th>
                    <th scope="col" className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {expandedAttribute.values.map((value) => (
                    <tr key={value.id} className="text-slate-700">
                      <td className="px-3 py-1.5" dir="ltr">{value.code}</td>
                      <td className="px-3 py-1.5">{value.valueFa}</td>
                      <td className="px-3 py-1.5 text-slate-500" dir="ltr">{value.valueEn ?? "—"}</td>
                      <td className="px-3 py-1.5 tabular-nums" dir="ltr">
                        {value.numericValue !== null ? faDigits(Number(value.numericValue)) : "—"}
                      </td>
                      <td className="px-3 py-1.5 text-center tabular-nums">{faDigits(value.displayOrder)}</td>
                      <td className="px-3 py-1.5 text-end">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setValueEditor({
                              mode: "edit",
                              id: value.id,
                              attributeId: expandedAttribute.id,
                              code: value.code,
                              valueFa: value.valueFa,
                              valueEn: value.valueEn ?? "",
                              numericValue: value.numericValue ?? "",
                              displayOrder: String(value.displayOrder),
                            })
                          }
                        >
                          ویرایش
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
