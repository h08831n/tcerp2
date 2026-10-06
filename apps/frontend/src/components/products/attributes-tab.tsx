"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { faDigits } from "@/lib/format";
import {
  addTemplateAttribute,
  fetchTemplate,
  productErrorMessage,
  removeTemplateAttribute,
  updateTemplateAttribute,
  type TemplateDetail,
} from "@/lib/product";

interface AddState {
  attribute: EntityOption | null;
  createsVariants: boolean;
  isRequired: boolean;
}

export function AttributesTab({
  template,
  onChanged,
}: {
  template: TemplateDetail;
  onChanged: (template: TemplateDetail) => void;
}) {
  const [add, setAdd] = useState<AddState>({ attribute: null, createsVariants: true, isRequired: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);

  const attachedIds = new Set(template.attributes.map((entry) => entry.attributeId));

  const attributesEndpoint = () => "/products/attributes?active=true&pageSize=50";
  const mapAttribute = (raw: unknown) => {
    const item = raw as Record<string, unknown>;
    const id = typeof item?.id === "string" ? item.id : "";
    const nameFa = typeof item?.nameFa === "string" ? item.nameFa : "";
    if (!id || !nameFa) return null;
    return {
      id,
      label: nameFa,
      sublabel: typeof item?.code === "string" ? item.code : undefined,
    };
  };

  async function handleAdd() {
    if (!add.attribute || saving) return;
    setSaving(true);
    setError(null);
    try {
      await addTemplateAttribute(template.id, {
        attributeId: add.attribute.id,
        createsVariants: add.createsVariants,
        isRequired: add.isRequired,
        displayOrder: template.attributes.length + 1,
      });
      setAdd({ attribute: null, createsVariants: true, isRequired: false });
      setNotice("ویژگی اضافه شد.");
      onChanged(await fetchTemplate(template.id));
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S adds when the picker has a selection.
  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        if (!add.attribute) return;
        event.preventDefault();
        void handleAdd();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [add, saving, template]);

  async function handleToggle(entryAttributeId: string, patch: { createsVariants?: boolean; isRequired?: boolean }) {
    setSaving(true);
    setError(null);
    try {
      await updateTemplateAttribute(template.id, entryAttributeId, patch);
      onChanged(await fetchTemplate(template.id));
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function move(index: number, direction: -1 | 1) {
    const entries = [...template.attributes];
    const targetIndex = index + direction;
    if (targetIndex < 0 || targetIndex >= entries.length) return;
    setSaving(true);
    setError(null);
    try {
      const current = entries[index];
      const target = entries[targetIndex];
      await updateTemplateAttribute(template.id, current.attributeId, {
        displayOrder: target.displayOrder,
      });
      await updateTemplateAttribute(template.id, target.attributeId, {
        displayOrder: current.displayOrder,
      });
      onChanged(await fetchTemplate(template.id));
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(entryAttributeId: string, nameFa: string) {
    setSaving(true);
    setError(null);
    try {
      await removeTemplateAttribute(template.id, entryAttributeId);
      setNotice(`ویژگی «${nameFa}» حذف شد.`);
      onChanged(await fetchTemplate(template.id));
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Add form */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h3 className="mb-3 text-sm font-bold text-slate-800">افزودن ویژگی به محصول</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-full sm:w-72">
            <span className="mb-1 block text-xs font-medium text-slate-600">ویژگی</span>
            <EntitySelector
              endpoint={attributesEndpoint}
              mapItem={mapAttribute}
              value={add.attribute}
              onChange={(value) => setAdd({ ...add, attribute: value })}
              placeholder="جستجوی ویژگی…"
              ariaLabel="انتخاب ویژگی"
              emptySearchLabel="برای جستجوی ویژگی تایپ کنید"
            />
          </div>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={add.createsVariants}
              onChange={(event) => setAdd({ ...add, createsVariants: event.target.checked })}
              className="h-4 w-4 accent-primary-600"
            />
            تعریف variant
          </label>
          <label className="flex cursor-pointer items-center gap-2 pb-2 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={add.isRequired}
              onChange={(event) => setAdd({ ...add, isRequired: event.target.checked })}
              className="h-4 w-4 accent-primary-600"
            />
            الزامی
          </label>
          <Button
            ref={addButtonRef}
            size="sm"
            onClick={() => void handleAdd()}
            disabled={saving || !add.attribute}
          >
            افزودن
          </Button>
        </div>
        {error && (
          <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}
        {notice && !error && (
          <p className="mt-3 text-xs text-emerald-700" role="status">{notice}</p>
        )}
      </div>

      {/* Ordered list */}
      <div className="overflow-hidden rounded-xl border border-slate-200 shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50/70 px-4 py-3">
          <h3 className="text-sm font-bold text-slate-800">
            ویژگی‌های محصول (به ترتیب نمایش) — {faDigits(template.attributes.length)} ردیف
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="ویژگی‌های محصول">
            <thead>
              <tr className="bg-white text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-center">ترتیب</th>
                <th scope="col" className="px-4 py-2 text-start">ویژگی</th>
                <th scope="col" className="px-4 py-2 text-start">کد</th>
                <th scope="col" className="px-4 py-2 text-center">تعداد مقادیر</th>
                <th scope="col" className="px-4 py-2 text-center">تعریف variant</th>
                <th scope="col" className="px-4 py-2 text-center">الزامی</th>
                <th scope="col" className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {template.attributes.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-xs text-slate-400">
                    ویژگی‌ای به این محصول متصل نشده است.
                  </td>
                </tr>
              ) : (
                template.attributes.map((entry, index) => (
                  <tr key={entry.id} className="text-slate-700 hover:bg-slate-50">
                    <td className="px-4 py-2 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          onClick={() => void move(index, -1)}
                          disabled={saving || index === 0}
                          aria-label={`جابه‌جایی ${entry.attribute.nameFa} به بالا`}
                          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="M18 15l-6-6-6 6" /></svg>
                        </button>
                        <span className="tabular-nums">{faDigits(entry.displayOrder)}</span>
                        <button
                          type="button"
                          onClick={() => void move(index, 1)}
                          disabled={saving || index === template.attributes.length - 1}
                          aria-label={`جابه‌جایی ${entry.attribute.nameFa} به پایین`}
                          className="flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 disabled:opacity-30"
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                            strokeLinecap="round" className="h-3.5 w-3.5" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-2 font-medium text-slate-800">{entry.attribute.nameFa}</td>
                    <td className="px-4 py-2" dir="ltr">{entry.attribute.code}</td>
                    <td className="px-4 py-2 text-center tabular-nums">{faDigits(entry.attribute.values.length)}</td>
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={entry.createsVariants}
                        disabled={saving}
                        onChange={(event) => void handleToggle(entry.attributeId, { createsVariants: event.target.checked })}
                        aria-label={`تعریف variant برای ${entry.attribute.nameFa}`}
                        className="h-4 w-4 accent-primary-600"
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <input
                        type="checkbox"
                        checked={entry.isRequired}
                        disabled={saving}
                        onChange={(event) => void handleToggle(entry.attributeId, { isRequired: event.target.checked })}
                        aria-label={`الزامی بودن ${entry.attribute.nameFa}`}
                        className="h-4 w-4 accent-primary-600"
                      />
                    </td>
                    <td className="px-4 py-2 text-end">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:bg-red-50"
                        onClick={() => void handleRemove(entry.attributeId, entry.attribute.nameFa)}
                        disabled={saving}
                      >
                        حذف
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      {attachedIds.size === 0 && (
        <p className="text-xs text-slate-400">
          ویژگی‌های تعریف‌کننده variant از تب «محصولات (Variants)» برای تولید ماتریس استفاده می‌شوند.
        </p>
      )}
    </div>
  );
}
