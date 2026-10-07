"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { faDigits, jalali, jalaliDateTime } from "@/lib/format";
import { fetchAllCategories } from "@/lib/product";
import {
  PUBLISH_BATCH_STATUS_BADGE_CLASSES,
  PUBLISH_BATCH_STATUS_LABELS,
  PUBLISH_BATCH_STATUSES,
  PUBLISH_CHANNELS,
  PUBLISH_CHANNEL_LABELS,
  createPublishBatch,
  fetchPublishBatches,
  fetchPublishingTemplates,
  publishingErrorMessage,
  renderPublishPreview,
  type PublishBatchDto,
  type PublishBatchStatus,
  type PublishChannel,
  type PublishingTemplateDto,
} from "@/lib/publishing";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function StatusBadge({ status }: { status: PublishBatchStatus }) {
  return (
    <span
      className={`rounded border px-1.5 py-0.5 text-[10px] font-bold ${PUBLISH_BATCH_STATUS_BADGE_CLASSES[status]}`}
    >
      {PUBLISH_BATCH_STATUS_LABELS[status]}
    </span>
  );
}

interface ChannelDraft {
  enabled: boolean;
  destination: string;
  templateCode: string; // "" = channel default
}

interface VariantChip {
  variantId: string;
  label: string;
}

const emptyChannelDraft: Record<PublishChannel, ChannelDraft> = PUBLISH_CHANNELS.reduce(
  (acc, channel) => {
    acc[channel] = { enabled: false, destination: "", templateCode: "" };
    return acc;
  },
  {} as Record<PublishChannel, ChannelDraft>,
);

function NewBatchWizard({
  open,
  onClose,
  templates,
}: {
  open: boolean;
  onClose: () => void;
  templates: PublishingTemplateDto[];
}) {
  const router = useRouter();
  const [priceDate, setPriceDate] = useState<string>(todayIso);
  const [channels, setChannels] = useState<Record<PublishChannel, ChannelDraft>>({
    ...emptyChannelDraft,
  });
  const [scope, setScope] = useState<"category" | "manual">("category");
  const [categoryId, setCategoryId] = useState("");
  const [categories, setCategories] = useState<{ id: string; nameFa: string }[]>([]);
  const [variantDraft, setVariantDraft] = useState<VariantSelection | null>(null);
  const [variantChips, setVariantChips] = useState<VariantChip[]>([]);
  const [notes, setNotes] = useState("");

  // Preview
  const [previewVariant, setPreviewVariant] = useState<VariantSelection | null>(null);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const list = await fetchAllCategories("true");
        setCategories(list.map((category) => ({ id: category.id, nameFa: category.nameFa })));
      } catch {
        // Category dropdown stays empty; manual scope still works.
      }
    })();
  }, [open]);

  const enabledChannels = PUBLISH_CHANNELS.filter((channel) => channels[channel].enabled);

  function reset() {
    setPriceDate(todayIso());
    setChannels({ ...emptyChannelDraft });
    setScope("category");
    setCategoryId("");
    setVariantDraft(null);
    setVariantChips([]);
    setNotes("");
    setPreviewText(null);
    setPreviewWarnings([]);
    setPreviewError(null);
    setError(null);
  }

  async function runPreview() {
    if (!previewVariant) {
      setPreviewError("برای پیش‌نمایش، یک محصول (variant) نمونه انتخاب کنید.");
      return;
    }
    const firstEnabled = enabledChannels[0];
    if (!firstEnabled) {
      setPreviewError("ابتدا حداقل یک کانال را انتخاب کنید.");
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const draft = channels[firstEnabled];
      const result = await renderPublishPreview({
        variantId: previewVariant.variantId,
        date: priceDate,
        ...(draft.templateCode
          ? {
              templateId: templates.find(
                (template) => template.code === draft.templateCode && template.channel === firstEnabled,
              )?.id,
            }
          : { channel: firstEnabled }),
      });
      setPreviewText(result.text);
      setPreviewWarnings(result.warnings);
    } catch (err) {
      setPreviewText(null);
      setPreviewWarnings([]);
      setPreviewError(publishingErrorMessage(err));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleCreate() {
    setError(null);
    if (enabledChannels.length === 0) {
      setError("انتخاب حداقل یک کانال الزامی است.");
      return;
    }
    if (scope === "category" && !categoryId) {
      setError("گروه کالایی را انتخاب کنید یا به انتخاب دستی سوئیچ کنید.");
      return;
    }
    if (scope === "manual" && variantChips.length === 0) {
      setError("حداقل یک محصول به فهرست انتشار اضافه کنید.");
      return;
    }
    setCreating(true);
    try {
      const result = await createPublishBatch({
        priceDate,
        channels: enabledChannels.map((channel) => ({
          channel,
          ...(channels[channel].destination.trim()
            ? { destination: channels[channel].destination.trim() }
            : {}),
          ...(channels[channel].templateCode ? { templateCode: channels[channel].templateCode } : {}),
        })),
        ...(scope === "category"
          ? { categoryId }
          : { variantIds: variantChips.map((chip) => chip.variantId) }),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
      });
      router.push(`/publishing/${result.batch.id}`);
    } catch (err) {
      setError(publishingErrorMessage(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Modal
      open={open}
      title="انتشار جدید قیمت"
      onClose={() => {
        onClose();
      }}
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            انصراف (Esc)
          </Button>
          <Button size="sm" onClick={() => void handleCreate()} disabled={creating}>
            {creating ? "در حال ایجاد…" : "ایجاد و ارسال به صف"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="max-w-56">
          <label className={fieldLabel}>تاریخ قیمت</label>
          <JalaliDateInput value={priceDate} onChange={(iso) => iso && setPriceDate(iso)} ariaLabel="تاریخ قیمت انتشار" />
        </div>

        <fieldset>
          <legend className={fieldLabel}>کانال‌های انتشار</legend>
          <div className="space-y-2">
            {PUBLISH_CHANNELS.map((channel) => {
              const draft = channels[channel];
              const channelTemplates = templates.filter(
                (template) => template.channel === channel && template.isActive,
              );
              return (
                <div
                  key={channel}
                  className={`rounded-lg border p-2.5 ${draft.enabled ? "border-primary-300 bg-primary-50/40" : "border-slate-200"}`}
                >
                  <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                    <input
                      type="checkbox"
                      checked={draft.enabled}
                      onChange={(event) =>
                        setChannels((current) => ({
                          ...current,
                          [channel]: { ...current[channel], enabled: event.target.checked },
                        }))
                      }
                      className="h-4 w-4 accent-primary-600"
                    />
                    {PUBLISH_CHANNEL_LABELS[channel]}
                  </label>
                  {draft.enabled && (
                    <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-[11px] text-slate-500">
                          مقصد (اختیاری — خالی = پیش‌فرض کانال)
                        </label>
                        <Input
                          inputSize="sm"
                          dir="ltr"
                          value={draft.destination}
                          onChange={(event) =>
                            setChannels((current) => ({
                              ...current,
                              [channel]: { ...current[channel], destination: event.target.value },
                            }))
                          }
                          placeholder="chat id / channel id"
                          aria-label={`مقصد کانال ${PUBLISH_CHANNEL_LABELS[channel]}`}
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-[11px] text-slate-500">قالب</label>
                        <select
                          value={draft.templateCode}
                          onChange={(event) =>
                            setChannels((current) => ({
                              ...current,
                              [channel]: { ...current[channel], templateCode: event.target.value },
                            }))
                          }
                          aria-label={`قالب کانال ${PUBLISH_CHANNEL_LABELS[channel]}`}
                          className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                        >
                          <option value="">قالب پیش‌فرض فعال کانال</option>
                          {channelTemplates.map((template) => (
                            <option key={template.id} value={template.code}>
                              {template.nameFa} ({template.code})
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend className={fieldLabel}>محدوده محصولات</legend>
          <div className="flex gap-4 text-xs text-slate-700">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="publish-scope"
                checked={scope === "category"}
                onChange={() => setScope("category")}
                className="accent-primary-600"
              />
              گروه کالایی
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input
                type="radio"
                name="publish-scope"
                checked={scope === "manual"}
                onChange={() => setScope("manual")}
                className="accent-primary-600"
              />
              انتخاب دستی محصولات
            </label>
          </div>
          {scope === "category" ? (
            <div className="mt-2 max-w-72">
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
                aria-label="انتخاب گروه کالایی برای انتشار"
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                <option value="">انتخاب گروه…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.nameFa}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-[11px] text-slate-400">
                همه variantهای فعال این گروه که در تاریخ انتخابی قیمت دارند منتشر می‌شوند.
              </p>
            </div>
          ) : (
            <div className="mt-2 space-y-2">
              <div className="grid grid-cols-[1fr_auto] items-end gap-2">
                <VariantSelector value={variantDraft} onChange={setVariantDraft} />
                <Button
                  size="md"
                  variant="secondary"
                  disabled={!variantDraft}
                  onClick={() => {
                    if (!variantDraft) return;
                    setVariantChips((current) =>
                      current.some((chip) => chip.variantId === variantDraft.variantId)
                        ? current
                        : [
                            ...current,
                            { variantId: variantDraft.variantId, label: variantDraft.label },
                          ],
                    );
                    setVariantDraft(null);
                  }}
                >
                  افزودن
                </Button>
              </div>
              {variantChips.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="محصولات انتخاب‌شده">
                  {variantChips.map((chip) => (
                    <li
                      key={chip.variantId}
                      className="flex items-center gap-1 rounded-full border border-slate-300 bg-slate-50 py-0.5 pe-2 ps-3 text-xs text-slate-700"
                    >
                      {chip.label}
                      <button
                        type="button"
                        aria-label={`حذف ${chip.label}`}
                        onClick={() =>
                          setVariantChips((current) =>
                            current.filter((item) => item.variantId !== chip.variantId),
                          )
                        }
                        className="rounded-full px-1 text-slate-400 hover:bg-slate-200 hover:text-slate-600"
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>

        <fieldset className="rounded-lg border border-slate-200 p-3">
          <legend className="px-1 text-xs font-medium text-slate-600">پیش‌نمایش (اختیاری)</legend>
          <div className="grid grid-cols-[1fr_auto] items-end gap-2">
            <VariantSelector value={previewVariant} onChange={setPreviewVariant} />
            <Button variant="secondary" onClick={() => void runPreview()} disabled={previewLoading}>
              {previewLoading ? "…" : "پیش‌نمایش"}
            </Button>
          </div>
          {previewError && <p className="mt-2 text-xs text-red-600">{previewError}</p>}
          {previewText !== null && (
            <div className="mt-2">
              <pre
                dir="rtl"
                className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-6 text-slate-700"
              >
                {previewText}
              </pre>
              {previewWarnings.length > 0 && (
                <ul className="mt-1 list-inside list-disc text-[11px] text-amber-600">
                  {previewWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </fieldset>

        <div>
          <label htmlFor="publish-notes" className={fieldLabel}>
            یادداشت (اختیاری)
          </label>
          <Input
            id="publish-notes"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            aria-label="یادداشت انتشار"
          />
        </div>
      </div>
    </Modal>
  );
}

function BatchesContent() {
  const [status, setStatus] = useState<PublishBatchStatus | "">("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<PublishBatchDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<PublishingTemplateDto[]>([]);
  const [wizardOpen, setWizardOpen] = useState(false);

  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchPublishBatches({
        page,
        pageSize,
        ...(status ? { status } : {}),
      });
      setItems(result.items);
      setTotal(result.total);
    } catch (err) {
      setError(publishingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void (async () => {
      try {
        setTemplates(await fetchPublishingTemplates());
      } catch {
        // Wizard falls back to channel default templates.
      }
    })();
  }, []);

  const columns = useMemo<DataTableColumn<PublishBatchDto>[]>(
    () => [
      {
        key: "batchNumber",
        header: "شماره",
        render: (row) => (
          <span dir="ltr" className="text-sm font-bold text-primary-700">
            {row.batchNumber}
          </span>
        ),
      },
      {
        key: "priceDate",
        header: "تاریخ قیمت",
        render: (row) => (
          <span className="text-xs tabular-nums text-slate-700">{jalali(row.priceDate)}</span>
        ),
      },
      {
        key: "status",
        header: "وضعیت",
        render: (row) => <StatusBadge status={row.status} />,
      },
      {
        key: "itemsCount",
        header: "تعداد آیتم‌ها",
        align: "center",
        render: (row) => (
          <span className="text-xs tabular-nums text-slate-700">{faDigits(row.itemsCount ?? 0)}</span>
        ),
      },
      {
        key: "createdAt",
        header: "تاریخ ایجاد",
        render: (row) => (
          <span className="text-xs tabular-nums text-slate-500">{jalaliDateTime(row.createdAt)}</span>
        ),
      },
      {
        key: "notes",
        header: "یادداشت",
        render: (row) => <span className="text-[11px] text-slate-400">{row.notes ?? "—"}</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">صف انتشار قیمت</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            هر بچ در یک تاریخ قیمت برای کانال‌های انتخابی فن‌اوت می‌شود؛ وضعیت هر آیتم مستقل است.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="w-40">
            <label htmlFor="batch-status" className={fieldLabel}>
              وضعیت
            </label>
            <select
              id="batch-status"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as PublishBatchStatus | "");
                setPage(1);
              }}
              className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">همه</option>
              {PUBLISH_BATCH_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {PUBLISH_BATCH_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
          <Button onClick={() => setWizardOpen(true)} aria-label="ایجاد بچ انتشار جدید">
            انتشار جدید
          </Button>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <DataTable<PublishBatchDto>
        columns={columns}
        rows={items}
        rowKey={(row) => row.id}
        rowHref={(row) => `/publishing/${row.id}`}
        getRowAriaLabel={(row) => `باز کردن بچ ${row.batchNumber}`}
        loading={loading}
        ariaLabel="فهرست بچ‌های انتشار"
        pagination={{ page, pageSize, total, onPageChange: setPage }}
      />

      <NewBatchWizard open={wizardOpen} onClose={() => setWizardOpen(false)} templates={templates} />
    </div>
  );
}

export default function PublishingPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-400">در حال بارگذاری…</p>}>
      <BatchesContent />
    </Suspense>
  );
}
