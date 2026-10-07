/**
 * Publishing engine API types and helpers (Phase 5, REQUIREMENTS §18).
 * Contract source of truth: apps/backend/src/publishing/* controllers + DTOs
 * + publishing.service.ts / publishing-template.service.ts.
 */

import { ApiError, apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

// ---------------------------------------------------------------------------
// Enums + Persian label maps
// ---------------------------------------------------------------------------

export type PublishChannel =
  | "WEBSITE"
  | "TELEGRAM"
  | "WHATSAPP"
  | "EITAA"
  | "BALE"
  | "RUBIKA"
  | "SMS";

export const PUBLISH_CHANNELS: PublishChannel[] = [
  "WEBSITE",
  "TELEGRAM",
  "WHATSAPP",
  "EITAA",
  "BALE",
  "RUBIKA",
  "SMS",
];

export const PUBLISH_CHANNEL_LABELS: Record<PublishChannel, string> = {
  WEBSITE: "وب‌سایت",
  TELEGRAM: "تلگرام",
  WHATSAPP: "واتس‌اپ",
  EITAA: "ایتا",
  BALE: "بله",
  RUBIKA: "روبیکا",
  SMS: "پیامک",
};

export type PublishBatchStatus =
  | "PENDING"
  | "PROCESSING"
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED";

export const PUBLISH_BATCH_STATUSES: PublishBatchStatus[] = [
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
];

export const PUBLISH_BATCH_STATUS_LABELS: Record<PublishBatchStatus, string> = {
  PENDING: "در انتظار",
  PROCESSING: "در حال ارسال",
  COMPLETED: "موفق",
  PARTIAL: "جزئی",
  FAILED: "ناموفق",
  CANCELLED: "لغو",
};

export const PUBLISH_BATCH_STATUS_BADGE_CLASSES: Record<PublishBatchStatus, string> = {
  PENDING: "border-slate-300 bg-slate-100 text-slate-600",
  PROCESSING: "border-sky-200 bg-sky-50 text-sky-700",
  COMPLETED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  PARTIAL: "border-amber-200 bg-amber-50 text-amber-700",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  CANCELLED: "border-rose-200 bg-rose-50 text-rose-700",
};

export type PublishItemStatus = "PENDING" | "PROCESSING" | "SUCCESS" | "FAILED" | "CANCELLED";

export const PUBLISH_ITEM_STATUSES: PublishItemStatus[] = [
  "PENDING",
  "PROCESSING",
  "SUCCESS",
  "FAILED",
  "CANCELLED",
];

export const PUBLISH_ITEM_STATUS_LABELS: Record<PublishItemStatus, string> = {
  PENDING: "در انتظار",
  PROCESSING: "در حال ارسال",
  SUCCESS: "موفق",
  FAILED: "ناموفق",
  CANCELLED: "لغو",
};

export const PUBLISH_ITEM_STATUS_BADGE_CLASSES: Record<PublishItemStatus, string> = {
  PENDING: "border-slate-300 bg-slate-100 text-slate-600",
  PROCESSING: "border-sky-200 bg-sky-50 text-sky-700",
  SUCCESS: "border-emerald-200 bg-emerald-50 text-emerald-700",
  FAILED: "border-red-200 bg-red-50 text-red-700",
  CANCELLED: "border-rose-200 bg-rose-50 text-rose-700",
};

/** Persian translation of well-known backend error tokens. */
export function publishingErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const message = error.message;
    if (message === "NO_ADAPTER_CONFIG")
      return "پیکربندی اتصال برای این کانال یافت نشد؛ ابتدا آن را در تنظیمات یکپارچه‌سازی ثبت کنید.";
    if (message === "NO_ADAPTER")
      return "آداپتور ارسال برای این کانال در سرور فعال نیست.";
    if (message === "NO_PUBLISHING_TEMPLATE")
      return "برای این کانال قالب فعالی وجود ندارد؛ ابتدا قالب بسازید.";
    if (message === "NO_PRICES_FOR_DATE")
      return "برای تاریخ انتخابی هیچ قیمتی ثبت نشده است.";
    if (message === "NO_VARIANTS_MATCHED")
      return "هیچ محصولی با این فیلترها یافت نشد.";
    if (message === "INVALID_STATUS_TRANSITION")
      return "این تغییر وضعیت مجاز نیست؛ صفحه را بازخوانی کنید.";
    if (message === "VERSION_CONFLICT")
      return "رکورد تغییر کرده است. آن را بازخوانی کنید.";
    if (message.includes("At least one channel"))
      return "انتخاب حداقل یک کانال الزامی است.";
    if (message.includes("Only FAILED or CANCELLED items can be retried"))
      return "فقط آیتم‌های ناموفق یا لغوشده قابل تلاش مجدد هستند.";
    if (message.includes("Only PENDING or FAILED items can be cancelled"))
      return "فقط آیتم‌های در انتظار یا ناموفق قابل لغو هستند.";
    if (message.includes("variantIds or categoryId"))
      return "محدوده انتشار را مشخص کنید (گروه کالایی یا انتخاب محصولات).";
    if (message.includes("No daily price for this variant"))
      return "برای این محصول در تاریخ انتخابی قیمتی ثبت نشده است.";
    if (message.includes("already exists")) return "این کد قبلاً ثبت شده است.";
    return message;
  }
  if (error instanceof Error) return error.message;
  return "خطایی رخ داد.";
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface PublishBatchDto {
  id: string;
  companyId: string;
  batchNumber: string;
  priceDate: string;
  status: PublishBatchStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
  itemsCount?: number;
}

export interface PublishBatchQuery {
  page?: number;
  pageSize?: number;
  status?: PublishBatchStatus;
  channel?: PublishChannel;
  date?: string;
}

export function fetchPublishBatches(
  query: PublishBatchQuery = {},
): Promise<PaginatedResponse<PublishBatchDto>> {
  const params = new URLSearchParams();
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  if (query.status) params.set("status", query.status);
  if (query.channel) params.set("channel", query.channel);
  if (query.date) params.set("date", query.date);
  return apiJson<PaginatedResponse<PublishBatchDto>>(`/publishing/batches?${params.toString()}`);
}

export interface PublishBatchTemplateRef {
  id: string;
  code: string;
  nameFa: string;
  channel: PublishChannel;
}

export interface PublishBatchItemDto {
  id: string;
  companyId: string;
  batchId: string;
  channel: PublishChannel;
  destination: string | null;
  templateId: string | null;
  renderedPayload: unknown;
  status: PublishItemStatus;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  providerResponse: unknown;
  queuedJobId: string | null;
  priceDate: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  template: PublishBatchTemplateRef | null;
}

export interface PublishBatchDetail extends PublishBatchDto {
  items: PublishBatchItemDto[];
}

export function fetchPublishBatch(id: string): Promise<PublishBatchDetail> {
  return apiJson<PublishBatchDetail>(`/publishing/batches/${id}`);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export interface PublishChannelEntry {
  channel: PublishChannel;
  /** Channel id / chat id / webhook target; empty = the channel default. */
  destination?: string;
  /** Publishing template code override (else the channel's active template). */
  templateCode?: string;
}

export interface CreatePublishBatchBody {
  /** YYYY-MM-DD; defaults to today. */
  priceDate?: string;
  channels: PublishChannelEntry[];
  variantIds?: string[];
  /** Alternative to variantIds: all variants of the category with a price that day. */
  categoryId?: string;
  notes?: string;
}

export interface CreatePublishBatchResult {
  batch: PublishBatchDto;
  items: PublishBatchItemDto[];
  skippedDuplicates: { channel: PublishChannel; destination: string }[];
  queueJobIds: string[];
}

export function createPublishBatch(body: CreatePublishBatchBody): Promise<CreatePublishBatchResult> {
  return apiJson<CreatePublishBatchResult>("/publishing/batches", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function retryPublishItem(itemId: string): Promise<PublishBatchItemDto> {
  return apiJson<PublishBatchItemDto>(`/publishing/items/${itemId}/retry`, { method: "POST" });
}

export function cancelPublishItem(itemId: string): Promise<PublishBatchItemDto> {
  return apiJson<PublishBatchItemDto>(`/publishing/items/${itemId}/cancel`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface PublishingTemplateDto {
  id: string;
  companyId: string;
  channel: PublishChannel;
  code: string;
  nameFa: string;
  bodyTemplate: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function fetchPublishingTemplates(): Promise<PublishingTemplateDto[]> {
  return apiJson<PublishingTemplateDto[]>("/publishing/templates");
}

export interface CreatePublishingTemplateBody {
  channel: PublishChannel;
  code: string;
  nameFa: string;
  bodyTemplate: string;
  isActive?: boolean;
}

export function createPublishingTemplate(
  body: CreatePublishingTemplateBody,
): Promise<PublishingTemplateDto> {
  return apiJson<PublishingTemplateDto>("/publishing/templates", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export interface UpdatePublishingTemplateBody {
  channel?: PublishChannel;
  nameFa?: string;
  bodyTemplate?: string;
  isActive?: boolean;
}

export function updatePublishingTemplate(
  id: string,
  body: UpdatePublishingTemplateBody,
): Promise<PublishingTemplateDto> {
  return apiJson<PublishingTemplateDto>(`/publishing/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function deletePublishingTemplate(id: string): Promise<{ success: boolean }> {
  return apiJson<{ success: boolean }>(`/publishing/templates/${id}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Render preview (POST /publishing/templates/render-preview)
// ---------------------------------------------------------------------------

export interface RenderPreviewBody {
  templateId?: string;
  bodyTemplate?: string;
  channel?: PublishChannel;
  variantId: string;
  date?: string;
}

export interface RenderPreviewResult {
  text: string;
  warnings: string[];
  vars: Record<string, string>;
  templateId: string | null;
  templateCode: string | null;
  channel: PublishChannel | null;
  date: string;
}

export function renderPublishPreview(body: RenderPreviewBody): Promise<RenderPreviewResult> {
  return apiJson<RenderPreviewResult>("/publishing/templates/render-preview", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Placeholders supported by the backend renderBody helper. */
export const TEMPLATE_PLACEHOLDERS: { token: string; labelFa: string }[] = [
  { token: "{product}", labelFa: "نام محصول" },
  { token: "{variantSku}", labelFa: "کد variant" },
  { token: "{size}", labelFa: "سایز" },
  { token: "{grade}", labelFa: "گرید" },
  { token: "{brand}", labelFa: "برند" },
  { token: "{price}", labelFa: "قیمت" },
  { token: "{date}", labelFa: "تاریخ" },
  { token: "{uom}", labelFa: "واحد" },
];
