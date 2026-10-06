"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  FILE_CATEGORIES,
  FILE_CATEGORY_LABELS,
  attachmentDownloadUrl,
  fetchAttachments,
  productErrorMessage,
  uploadAttachment,
  type AttachmentDto,
  type FileCategory,
  type TemplateDetail,
} from "@/lib/product";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

function categoryLabel(category: string | null): string {
  if (!category) return "سایر";
  return FILE_CATEGORY_LABELS[category as FileCategory] ?? category;
}

function categoryBadge(category: string | null) {
  const classes: Record<string, string> = {
    catalog: "border-sky-200 bg-sky-50 text-sky-700",
    technical_specification: "border-violet-200 bg-violet-50 text-violet-700",
    certificate: "border-amber-200 bg-amber-50 text-amber-700",
    image: "border-emerald-200 bg-emerald-50 text-emerald-700",
    other: "border-slate-200 bg-slate-100 text-slate-600",
  };
  const key = category ?? "other";
  return (
    <span className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${classes[key] ?? classes.other}`}>
      {categoryLabel(category)}
    </span>
  );
}

export function FilesTab({ template }: { template: TemplateDetail }) {
  const [attachments, setAttachments] = useState<AttachmentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<FileCategory>("catalog");
  const [displayName, setDisplayName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchAttachments("product_template", template.id);
      setAttachments(items);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [template.id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEscClose(uploadOpen, () => {
    setUploadOpen(false);
    setFile(null);
    setDisplayName("");
    setUploadError(null);
  }, openButtonRef);

  useEffect(() => {
    if (uploadOpen) fileInputRef.current?.focus();
  }, [uploadOpen]);

  async function handleUpload() {
    if (!file || uploading) return;
    setUploading(true);
    setUploadError(null);
    try {
      await uploadAttachment({
        file,
        entityType: "product_template",
        entityId: template.id,
        category,
        displayName: displayName.trim() || undefined,
      });
      setUploadOpen(false);
      setFile(null);
      setDisplayName("");
      setNotice("فایل بارگذاری شد.");
      await load();
    } catch (err) {
      setUploadError(productErrorMessage(err));
    } finally {
      setUploading(false);
    }
  }

  // Ctrl+S uploads when a file is picked.
  useEffect(() => {
    if (!uploadOpen) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleUpload();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadOpen, file, category, displayName, uploading]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-800">
          پیوست‌های محصول — {faDigits(attachments.length)} فایل
        </h3>
        <Button
          ref={openButtonRef}
          size="sm"
          onClick={() => {
            setUploadOpen((open) => !open);
            setUploadError(null);
          }}
          aria-expanded={uploadOpen}
        >
          {uploadOpen ? "بستن فرم بارگذاری" : "بارگذاری فایل"}
        </Button>
      </div>

      {/* Upload form */}
      {uploadOpen && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="file-input" className={fieldLabel}>فایل *</label>
              <input
                ref={fileInputRef}
                id="file-input"
                type="file"
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                className="block w-full text-xs text-slate-600 file:me-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
            </div>
            <div>
              <label htmlFor="file-category" className={fieldLabel}>دسته</label>
              <select
                id="file-category"
                value={category}
                onChange={(event) => setCategory(event.target.value as FileCategory)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                {FILE_CATEGORIES.map((value) => (
                  <option key={value} value={value}>{FILE_CATEGORY_LABELS[value]}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="file-name" className={fieldLabel}>نام نمایشی</label>
              <input
                id="file-name"
                type="text"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              />
            </div>
          </div>
          {uploadError && (
            <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {uploadError}
            </div>
          )}
          <div className="mt-3 flex items-center gap-2">
            <Button size="sm" onClick={() => void handleUpload()} disabled={uploading || !file}>
              {uploading ? "در حال بارگذاری…" : "بارگذاری (Ctrl+S)"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setUploadOpen(false);
                setFile(null);
                setUploadError(null);
                openButtonRef.current?.focus();
              }}
              disabled={uploading}
            >
              انصراف (Esc)
            </Button>
          </div>
        </div>
      )}

      {notice && !uploadOpen && (
        <p className="text-xs text-emerald-700" role="status">{notice}</p>
      )}
      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Attachments list */}
      <div className="overflow-hidden rounded-xl border border-slate-200 shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" aria-label="پیوست‌های محصول">
            <thead>
              <tr className="bg-slate-50 text-xs text-slate-500">
                <th scope="col" className="px-4 py-2 text-start">نام فایل</th>
                <th scope="col" className="px-4 py-2 text-start">دسته</th>
                <th scope="col" className="px-4 py-2 text-start">حجم</th>
                <th scope="col" className="px-4 py-2 text-start">تاریخ</th>
                <th scope="col" className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-slate-400">در حال بارگذاری…</td>
                </tr>
              ) : attachments.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-xs text-slate-400">
                    فایلی پیوست نشده است.
                  </td>
                </tr>
              ) : (
                attachments.map((attachment) => (
                  <tr key={attachment.id} className="text-slate-700 hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <span className="block truncate font-medium text-slate-800" dir="auto">
                        {attachment.displayName ?? attachment.originalFilename}
                      </span>
                      {!attachment.displayName && (
                        <span className="block truncate text-[11px] text-slate-400" dir="ltr">
                          {attachment.originalFilename}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2">{categoryBadge(attachment.category)}</td>
                    <td className="px-4 py-2 tabular-nums" dir="ltr">
                      {faDigits(Math.max(1, Math.round(attachment.blob.size / 1024)))} کیلوبایت
                    </td>
                    <td className="px-4 py-2 tabular-nums text-slate-500">
                      {jalaliDateTime(attachment.createdAt)}
                    </td>
                    <td className="px-4 py-2 text-end">
                      <a
                        href={attachmentDownloadUrl(attachment.id)}
                        className="text-xs text-primary-600 underline hover:text-primary-700"
                      >
                        دانلود
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
