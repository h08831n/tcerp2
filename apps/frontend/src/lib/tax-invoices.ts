/** Tax invoices & Moadian API layer (Phase 8). Monetary values stay as
 *  backend decimal STRINGS — display goes through faMoneyExact. */

import { apiJson } from "@/lib/api";

export type SalesTaxInvoiceStatus =
  | "DRAFT"
  | "READY"
  | "SENDING"
  | "SUBMITTED"
  | "SUCCESS"
  | "FAILED"
  | "CANCELLED";

export const TAX_INVOICE_STATUS_LABELS: Record<SalesTaxInvoiceStatus, string> = {
  DRAFT: "پیش‌نویس",
  READY: "آماده ارسال",
  SENDING: "در حال ارسال",
  SUBMITTED: "ارسال‌شده (در انتظار)",
  SUCCESS: "ثبت‌شده در مودیان",
  FAILED: "ناموفق",
  CANCELLED: "لغوشده",
};

export const TAX_INVOICE_STATUS_CLASSES: Record<SalesTaxInvoiceStatus, string> = {
  DRAFT: "bg-slate-100 text-slate-700",
  READY: "bg-sky-100 text-sky-800",
  SENDING: "bg-amber-100 text-amber-800",
  SUBMITTED: "bg-indigo-100 text-indigo-800",
  SUCCESS: "bg-emerald-100 text-emerald-800",
  FAILED: "bg-rose-100 text-rose-800",
  CANCELLED: "bg-slate-100 text-slate-400",
};

export const TAX_INVOICE_SUBJECT_LABELS: Record<string, string> = {
  MAIN: "اصلی",
  CORRECTIVE: "اصلاحی",
  CANCEL: "ابطالی",
  RETURN: "برگشتی",
};

export interface SalesTaxInvoiceRow {
  id: string;
  number: string;
  status: SalesTaxInvoiceStatus;
  subject: string;
  customerPartyId: string;
  customer?: { nameFa: string };
  issueDate: string;
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  grandTotal: string;
  moadianStatus: string | null;
  moadianError: string | null;
  referenceNumber: string | null;
  confirmationReferenceId: string | null;
  createdAt: string;
}

export interface SalesTaxInvoiceLine {
  id: string;
  sstid: string | null;
  description: string;
  mu: string | null;
  quantity: string;
  unitPrice: string;
  prdis: string;
  dis: string;
  vra: string;
  vam: string;
  tsstam: string;
  lineOrder: number;
}

export interface SalesTaxInvoiceSubmission {
  id: string;
  uid: string;
  attempt: number;
  retry: boolean;
  status: "PENDING" | "SUCCESS" | "FAILED";
  referenceNumber: string | null;
  errorCode: string | null;
  errorDetail: string | null;
  confirmationReferenceId: string | null;
  taxResult: string | null;
  sentAt: string;
  inquiredAt: string | null;
}

export interface SalesTaxInvoiceDetail extends Omit<SalesTaxInvoiceRow, "customer"> {
  customer: { nameFa: string; nationalId: string | null; economicCode: string | null; nationalCode: string | null };
  lines: SalesTaxInvoiceLine[];
  submissions: SalesTaxInvoiceSubmission[];
  salesAllocations: Array<{ id: string; salesDocumentId: string; allocatedAmount: string }>;
}

export function fetchTaxInvoices(query: {
  status?: SalesTaxInvoiceStatus;
  customerId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}): Promise<Paginated<SalesTaxInvoiceRow>> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.customerId) params.set("customerId", query.customerId);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  return apiJson<Paginated<SalesTaxInvoiceRow>>(`/tax/invoices?${params.toString()}`);
}

export function fetchTaxInvoice(id: string): Promise<SalesTaxInvoiceDetail> {
  return apiJson<SalesTaxInvoiceDetail>(`/tax/invoices/${id}`);
}

export function createTaxInvoiceFromSales(input: {
  salesDocumentId: string;
  subject?: string;
  issueDate?: string;
}): Promise<SalesTaxInvoiceDetail> {
  return apiJson(`/tax/invoices/from-sales`, { method: "POST", body: JSON.stringify(input) });
}

export function sendTaxInvoice(id: string): Promise<{
  status: "SUBMITTED" | "FAILED";
  submissionId: string;
  uid?: string;
  referenceNumber?: string | null;
  errorCode?: string;
}> {
  return apiJson(`/tax/invoices/${id}/send`, { method: "POST" });
}

export function inquiryTaxInvoice(id: string): Promise<{ status: string }> {
  return apiJson(`/tax/invoices/${id}/inquiry`, { method: "POST" });
}

export function fetchSalesDocumentMoadianStatus(salesDocumentId: string): Promise<{
  moadianStatus: string;
  invoiceCount: number;
  coveredAmount: string;
  coveredPct: number | null;
}> {
  return apiJson(`/tax/invoices/sales-document/${salesDocumentId}/moadian-status`);
}

export function registerPurchaseTaxInvoice(input: {
  supplierPartyId: string;
  supplierInvoiceNumber: string;
  invoiceDate: string;
  total: string;
  taxTotal: string;
}): Promise<{ id: string; number: string }> {
  return apiJson(`/tax/invoices/purchase`, { method: "POST", body: JSON.stringify(input) });
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

const FA_ERRORS: Record<string, string> = {
  TAX_INVOICE_SOURCE_NOT_COMPLETED: "سند فروش هنوز تکمیل نشده است؛ صورتحساب فقط از سند تکمیل‌شده صادر می‌شود.",
  TAX_INVOICE_CUSTOMER_IDENTITY_MISSING: "کد اقتصادی/کد ملی مشتری ثبت نشده است.",
  TAX_INVOICE_NO_INVOICED_QUANTITY: "هیچ مقدار بارگیری‌شده‌ای برای صورتحساب وجود ندارد.",
  TAX_INVOICE_SEND_IN_PROGRESS: "ارسال دیگری برای این صورتحساب در جریان است.",
  TAX_INVOICE_NOT_SENDABLE: "این صورتحساب در وضعیت فعلی قابل ارسال نیست.",
  TAX_INVOICE_NO_PENDING_SUBMISSION: "ارسال در انتظار بررسی وجود ندارد؛ ابتدا صورتحساب را ارسال کنید.",
  TAX_INVOICE_ACCESS_FORBIDDEN: "دسترسی به صورتحساب‌های مالیاتی مجاز نیست.",
  ALLOCATION_EXISTS: "این تخصیص قبلاً ثبت شده است.",
};

export function taxInvoiceErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  for (const [key, fa] of Object.entries(FA_ERRORS)) {
    if (message.includes(key)) return fa;
  }
  return message || "خطایی در بخش صورتحساب‌های مالیاتی رخ داد.";
}
