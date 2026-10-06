"use client";

import { useCallback, useEffect, useState } from "react";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { fetchTemplate, type TemplateDetail } from "@/lib/product";

export interface VariantSelection {
  variantId: string;
  label: string;
  template: TemplateDetail;
}

function mapTemplate(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const nameFa = typeof item.nameFa === "string" ? item.nameFa : id;
  const internalCode = typeof item.internalCode === "string" ? item.internalCode : "";
  return {
    id,
    label: nameFa,
    sublabel: internalCode || undefined,
  };
}

/**
 * Keyboard-first variant picker without a global variant-search endpoint:
 * search templates (GET /products/templates?search=) then pick one of the
 * template's variants from a native select (arrow keys work natively).
 */
export function VariantSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: VariantSelection | null;
  onChange: (value: VariantSelection | null) => void;
  disabled?: boolean;
}) {
  const [template, setTemplate] = useState<EntityOption | null>(
    value ? { id: value.template.id, label: value.template.nameFa } : null,
  );
  const [detail, setDetail] = useState<TemplateDetail | null>(value?.template ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadTemplate = useCallback(async (templateId: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchTemplate(templateId);
      setDetail(result);
    } catch {
      setDetail(null);
      setError("خطا در دریافت variants محصول");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (template && template.id !== detail?.id) void loadTemplate(template.id);
    if (!template) {
      setDetail(null);
      if (value) onChange(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template]);

  const activeVariants = (detail?.variants ?? []).filter((variant) => variant.active);

  return (
    <div className="space-y-2">
      <EntitySelector
        endpoint={(search) =>
          `/products/templates?search=${encodeURIComponent(search)}&pageSize=10&active=true`
        }
        mapItem={mapTemplate}
        value={template}
        onChange={(next) => {
          setTemplate(next);
          if (!next) onChange(null);
        }}
        placeholder="جستجوی محصول…"
        ariaLabel="انتخاب محصول"
        disabled={disabled}
        emptySearchLabel="برای جستجوی محصول تایپ کنید"
      />
      {loading && <p className="text-xs text-slate-400">در حال دریافت variants…</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {template && !loading && detail && activeVariants.length === 0 && (
        <p className="text-xs text-amber-600">این محصول variant فعالی ندارد.</p>
      )}
      {template && detail && activeVariants.length > 0 && (
        <select
          value={value?.variantId ?? ""}
          disabled={disabled}
          onChange={(event) => {
            const variantId = event.target.value;
            const variant = activeVariants.find((item) => item.id === variantId);
            if (!variant) {
              onChange(null);
              return;
            }
            onChange({
              variantId: variant.id,
              label: `${variant.nameFa} (${variant.sku})`,
              template: detail,
            });
          }}
          aria-label="انتخاب variant محصول"
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:cursor-not-allowed disabled:bg-slate-50"
        >
          <option value="">انتخاب variant…</option>
          {activeVariants.map((variant) => (
            <option key={variant.id} value={variant.id}>
              {variant.nameFa} — {variant.sku}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
