"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { VariantSelector, type VariantSelection } from "@/components/documents/variant-selector";
import { jalaliDateTime } from "@/lib/format";
import {
  PUBLISH_CHANNELS,
  PUBLISH_CHANNEL_LABELS,
  TEMPLATE_PLACEHOLDERS,
  createPublishingTemplate,
  deletePublishingTemplate,
  fetchPublishingTemplates,
  publishingErrorMessage,
  renderPublishPreview,
  updatePublishingTemplate,
  type PublishChannel,
  type PublishingTemplateDto,
} from "@/lib/publishing";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

interface EditorState {
  mode: "create" | "edit";
  template: PublishingTemplateDto | null;
  channel: PublishChannel;
  code: string;
  nameFa: string;
  bodyTemplate: string;
  isActive: boolean;
}

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export default function PublishingTemplatesPage() {
  const [templates, setTemplates] = useState<PublishingTemplateDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<PublishingTemplateDto | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Preview modal
  const [previewTemplate, setPreviewTemplate] = useState<PublishingTemplateDto | null>(null);
  const [previewBody, setPreviewBody] = useState<{ body: string; channel: PublishChannel } | null>(null);
  const [previewVariant, setPreviewVariant] = useState<VariantSelection | null>(null);
  const [previewDate, setPreviewDate] = useState<string>(todayIso);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewWarnings, setPreviewWarnings] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setTemplates(await fetchPublishingTemplates());
    } catch (err) {
      setError(publishingErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setFormError(null);
    setEditor({
      mode: "create",
      template: null,
      channel: "WEBSITE",
      code: "",
      nameFa: "",
      bodyTemplate: "{product} {size} {brand}\nقیمت: {price} ریال — {date} ({uom})",
      isActive: true,
    });
  }

  function openEdit(template: PublishingTemplateDto) {
    setFormError(null);
    setEditor({
      mode: "edit",
      template,
      channel: template.channel,
      code: template.code,
      nameFa: template.nameFa,
      bodyTemplate: template.bodyTemplate,
      isActive: template.isActive,
    });
  }

  function insertPlaceholder(token: string) {
    const area = bodyRef.current;
    if (!area || !editor) return;
    const start = area.selectionStart ?? editor.bodyTemplate.length;
    const end = area.selectionEnd ?? start;
    const next = `${editor.bodyTemplate.slice(0, start)}${token}${editor.bodyTemplate.slice(end)}`;
    setEditor({ ...editor, bodyTemplate: next });
    requestAnimationFrame(() => {
      area.focus();
      const cursor = start + token.length;
      area.setSelectionRange(cursor, cursor);
    });
  }

  async function saveEditor() {
    if (!editor || saving) return;
    if (!editor.nameFa.trim()) {
      setFormError("نام قالب الزامی است.");
      return;
    }
    if (editor.mode === "create" && !editor.code.trim()) {
      setFormError("کد قالب الزامی است.");
      return;
    }
    if (!editor.bodyTemplate.trim()) {
      setFormError("متن قالب الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editor.mode === "create") {
        await createPublishingTemplate({
          channel: editor.channel,
          code: editor.code.trim(),
          nameFa: editor.nameFa.trim(),
          bodyTemplate: editor.bodyTemplate,
          isActive: editor.isActive,
        });
        setNotice("قالب انتشار ساخته شد.");
      } else if (editor.template) {
        await updatePublishingTemplate(editor.template.id, {
          channel: editor.channel,
          nameFa: editor.nameFa.trim(),
          bodyTemplate: editor.bodyTemplate,
          isActive: editor.isActive,
        });
        setNotice("قالب انتشار به‌روزرسانی شد.");
      }
      setEditor(null);
      await load();
    } catch (err) {
      setFormError(publishingErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(template: PublishingTemplateDto) {
    setError(null);
    try {
      await updatePublishingTemplate(template.id, { isActive: !template.isActive });
      await load();
    } catch (err) {
      setError(publishingErrorMessage(err));
    }
  }

  async function handleDelete() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    setError(null);
    try {
      await deletePublishingTemplate(deleteTarget.id);
      setDeleteTarget(null);
      setNotice("قالب حذف شد.");
      await load();
    } catch (err) {
      setError(publishingErrorMessage(err));
    } finally {
      setDeleting(false);
    }
  }

  function openPreview(template: PublishingTemplateDto) {
    setPreviewTemplate(template);
    setPreviewBody(null);
    setPreviewVariant(null);
    setPreviewDate(todayIso());
    setPreviewText(null);
    setPreviewWarnings([]);
    setPreviewError(null);
  }

  function openPreviewUnsaved(body: string, channel: PublishChannel) {
    setPreviewTemplate(null);
    setPreviewBody({ body, channel });
    setPreviewVariant(null);
    setPreviewDate(todayIso());
    setPreviewText(null);
    setPreviewWarnings([]);
    setPreviewError(null);
  }

  async function runPreview() {
    if (!previewVariant) {
      setPreviewError("برای پیش‌نمایش، یک محصول (variant) انتخاب کنید.");
      return;
    }
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const result = await renderPublishPreview({
        variantId: previewVariant.variantId,
        date: previewDate,
        ...(previewTemplate
          ? { templateId: previewTemplate.id }
          : previewBody
            ? { bodyTemplate: previewBody.body, channel: previewBody.channel }
            : {}),
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">قالب‌های انتشار</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            متن پیام هر کانال با جای‌نگارها ساخته می‌شود؛ برای هر کانال می‌توانید چند قالب داشته باشید.
          </p>
        </div>
        <Button onClick={openCreate} aria-label="قالب انتشار جدید">
          قالب جدید
        </Button>
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

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="فهرست قالب‌های انتشار">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-500">
                <th scope="col" className="px-3 py-2 text-start">کانال</th>
                <th scope="col" className="px-3 py-2 text-start">کد</th>
                <th scope="col" className="px-3 py-2 text-start">نام</th>
                <th scope="col" className="px-3 py-2 text-start">متن قالب</th>
                <th scope="col" className="px-3 py-2 text-center">فعال</th>
                <th scope="col" className="px-3 py-2 text-start">آخرین تغییر</th>
                <th scope="col" className="px-3 py-2 text-center">اکشن‌ها</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-400">
                    در حال بارگذاری…
                  </td>
                </tr>
              ) : templates.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-3 py-8 text-center text-sm text-slate-400">
                    هنوز قالبی ساخته نشده است.
                  </td>
                </tr>
              ) : (
                templates.map((template) => (
                  <tr key={template.id} className="align-top">
                    <td className="px-3 py-2 text-xs font-semibold text-slate-700">
                      {PUBLISH_CHANNEL_LABELS[template.channel]}
                    </td>
                    <td className="px-3 py-2">
                      <span dir="ltr" className="font-mono text-[11px] text-slate-600">
                        {template.code}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-700">{template.nameFa}</td>
                    <td className="max-w-72 px-3 py-2">
                      <span className="line-clamp-2 block whitespace-pre-wrap text-[11px] text-slate-500">
                        {template.bodyTemplate}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <label className="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-600">
                        <input
                          type="checkbox"
                          checked={template.isActive}
                          onChange={() => void toggleActive(template)}
                          className="h-4 w-4 accent-primary-600"
                          aria-label={`فعال بودن قالب ${template.nameFa}`}
                        />
                        {template.isActive ? "فعال" : "غیرفعال"}
                      </label>
                    </td>
                    <td className="px-3 py-2 text-[11px] tabular-nums text-slate-400">
                      {jalaliDateTime(template.updatedAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap items-center justify-center gap-1">
                        <Button size="sm" variant="secondary" onClick={() => openEdit(template)}>
                          ویرایش
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => openPreview(template)}>
                          پیش‌نمایش
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(template)}>
                          حذف
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

      {/* Editor modal */}
      <Modal
        open={editor !== null}
        title={editor?.mode === "create" ? "قالب انتشار جدید" : `ویرایش قالب ${editor?.nameFa ?? ""}`}
        onClose={() => setEditor(null)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditor(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void saveEditor()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+Enter)"}
            </Button>
          </>
        }
      >
        {editor && (
          <div
            className="space-y-3"
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") void saveEditor();
            }}
          >
            {formError && (
              <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                {formError}
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div>
                <label htmlFor="tpl-channel" className={fieldLabel}>
                  کانال
                </label>
                <select
                  id="tpl-channel"
                  value={editor.channel}
                  onChange={(event) =>
                    setEditor({ ...editor, channel: event.target.value as PublishChannel })
                  }
                  className="h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-sm text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                >
                  {PUBLISH_CHANNELS.map((channel) => (
                    <option key={channel} value={channel}>
                      {PUBLISH_CHANNEL_LABELS[channel]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="tpl-code" className={fieldLabel}>
                  کد {editor.mode === "edit" ? "(غیرقابل تغییر)" : ""}
                </label>
                <Input
                  id="tpl-code"
                  dir="ltr"
                  value={editor.code}
                  disabled={editor.mode === "edit"}
                  onChange={(event) => setEditor({ ...editor, code: event.target.value })}
                  placeholder="daily_price"
                />
              </div>
              <div>
                <label htmlFor="tpl-name" className={fieldLabel}>
                  نام فارسی
                </label>
                <Input
                  id="tpl-name"
                  value={editor.nameFa}
                  onChange={(event) => setEditor({ ...editor, nameFa: event.target.value })}
                />
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label htmlFor="tpl-body" className={fieldLabel}>
                  متن قالب
                </label>
                <label className="flex cursor-pointer items-center gap-1.5 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={editor.isActive}
                    onChange={(event) => setEditor({ ...editor, isActive: event.target.checked })}
                    className="h-4 w-4 accent-primary-600"
                  />
                  فعال
                </label>
              </div>
              <textarea
                id="tpl-body"
                ref={bodyRef}
                value={editor.bodyTemplate}
                onChange={(event) => setEditor({ ...editor, bodyTemplate: event.target.value })}
                rows={6}
                dir="rtl"
                className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm leading-6 text-slate-800 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {TEMPLATE_PLACEHOLDERS.map((placeholder) => (
                  <button
                    key={placeholder.token}
                    type="button"
                    onClick={() => insertPlaceholder(placeholder.token)}
                    title={placeholder.labelFa}
                    className="rounded border border-slate-300 bg-slate-50 px-2 py-0.5 font-mono text-[11px] text-slate-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700"
                  >
                    {placeholder.token}
                  </button>
                ))}
              </div>
            </div>

            {editor.mode === "edit" && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  openPreviewUnsaved(editor.bodyTemplate, editor.channel);
                  setEditor(null);
                }}
              >
                پیش‌نمایش این متن (بدون ذخیره)
              </Button>
            )}
          </div>
        )}
      </Modal>

      {/* Preview modal */}
      <Modal
        open={previewTemplate !== null || previewBody !== null}
        title={
          previewTemplate
            ? `پیش‌نمایش قالب ${previewTemplate.nameFa}`
            : previewBody
              ? `پیش‌نمایش متن (${PUBLISH_CHANNEL_LABELS[previewBody.channel]})`
              : "پیش‌نمایش قالب"
        }
        onClose={() => {
          setPreviewTemplate(null);
          setPreviewBody(null);
        }}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setPreviewTemplate(null);
                setPreviewBody(null);
              }}
            >
              بستن (Esc)
            </Button>
            <Button size="sm" onClick={() => void runPreview()} disabled={previewLoading}>
              {previewLoading ? "…" : "رندر پیش‌نمایش"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {previewError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {previewError}
            </div>
          )}
          <div>
            <label className={fieldLabel}>محصول (variant نمونه)</label>
            <VariantSelector value={previewVariant} onChange={setPreviewVariant} />
          </div>
          <div className="max-w-56">
            <label className={fieldLabel}>تاریخ</label>
            <JalaliDateInput
              value={previewDate}
              onChange={(iso) => iso && setPreviewDate(iso)}
              ariaLabel="تاریخ پیش‌نمایش"
            />
          </div>
          {previewText !== null && (
            <div>
              <pre
                dir="rtl"
                className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-xs leading-6 text-slate-700"
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
          <p className="text-[11px] text-slate-400">
            پیش‌نمایش از قیمت ثبت‌شده محصول در تاریخ انتخابی استفاده می‌کند؛ اگر قیمت آن روز موجود نباشد رندر خطا می‌دهد.
          </p>
        </div>
      </Modal>

      {/* Delete confirm */}
      <Modal
        open={deleteTarget !== null}
        title="حذف قالب انتشار"
        onClose={() => setDeleteTarget(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDeleteTarget(null)}>
              انصراف (Esc)
            </Button>
            <Button variant="danger" size="sm" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? "در حال حذف…" : "حذف"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">
          قالب «{deleteTarget?.nameFa}» ({PUBLISH_CHANNEL_LABELS[deleteTarget?.channel ?? "WEBSITE"]}) حذف شود؟
        </p>
      </Modal>
    </div>
  );
}
