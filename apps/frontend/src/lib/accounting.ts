/**
 * Accounting API layer (Phase 7D) — reports, fiscal lifecycle and journal
 * drill-down. All monetary values stay as backend decimal STRINGS; display
 * formatting goes through `faMoneyExact` which never touches a JS float.
 */

import { apiJson } from "@/lib/api";

// ---------------------------------------------------------------------------
// General Ledger (دفتر کل)
// ---------------------------------------------------------------------------

export interface LedgerRow {
  entryId: string;
  entryNumber: string;
  entryDate: string;
  journalCode: string;
  documentType: string | null;
  description: string | null;
  debit: string;
  credit: string;
  runningBalance: string;
  reversed: boolean;
  reversalEntryId: string | null;
}

export interface LedgerReport {
  accountCode: string;
  accountName: string;
  accountIds: string[];
  normalSide: "DEBIT" | "CREDIT";
  openingBalance: string;
  rows: LedgerRow[];
  nextCursor: string | null;
  totals: { debit: string; credit: string; closingBalance: string };
}

export interface GeneralLedgerQuery {
  accountCode: string;
  from?: string;
  to?: string;
  journalCode?: string;
  partyId?: string;
  analyticType?: string;
  analyticId?: string;
  limit?: number;
  cursor?: string | null;
}

export function fetchGeneralLedger(query: GeneralLedgerQuery): Promise<LedgerReport> {
  const params = new URLSearchParams();
  params.set("accountCode", query.accountCode);
  for (const key of ["from", "to", "journalCode", "partyId", "analyticType", "analyticId"] as const) {
    if (query[key]) params.set(key, String(query[key]));
  }
  if (query.limit) params.set("limit", String(query.limit));
  if (query.cursor) params.set("cursor", query.cursor);
  return apiJson<LedgerReport>(`/accounting/reports/general-ledger?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Trial Balance (تراز آزمایشی)
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  level: "leaf" | "parent";
  openingDebit: string;
  openingCredit: string;
  debit: string;
  credit: string;
  closingDebit: string;
  closingCredit: string;
}

export interface TrialBalanceReport {
  from: string | null;
  to: string;
  level: string;
  rows: TrialBalanceRow[];
  totals: {
    openingDebit: string;
    openingCredit: string;
    debit: string;
    credit: string;
    closingDebit: string;
    closingCredit: string;
  };
  balanced: boolean;
}

export interface TrialBalanceQuery {
  from?: string;
  to?: string;
  asOf?: string;
  fiscalYearId?: string;
  periodId?: string;
  level?: "leaf" | "summary" | "all";
}

export function fetchTrialBalance(query: TrialBalanceQuery = {}): Promise<TrialBalanceReport> {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "asOf", "fiscalYearId", "periodId", "level"] as const) {
    if (query[key]) params.set(key, String(query[key]));
  }
  return apiJson<TrialBalanceReport>(`/accounting/reports/trial-balance?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Subsidiary Ledger (دفتر معین)
// ---------------------------------------------------------------------------

export interface PartyBalanceRow {
  partyId: string;
  nameFa: string;
  debit: string | null;
  credit: string | null;
  lastActivity: string | null;
  total: number;
}

export interface PartyBalanceQuery {
  role: "CUSTOMER" | "SUPPLIER";
  accountCode?: string;
  asOf?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function fetchPartyBalances(query: PartyBalanceQuery): Promise<Paginated<PartyBalanceRow>> {
  const params = new URLSearchParams();
  params.set("role", query.role);
  if (query.accountCode) params.set("accountCode", query.accountCode);
  if (query.asOf) params.set("asOf", query.asOf);
  if (query.search) params.set("search", query.search);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 25));
  return apiJson<Paginated<PartyBalanceRow>>(`/accounting/reports/subsidiary-ledger?${params.toString()}`);
}

export interface PartyLedgerQuery {
  accountCode?: string;
  from?: string;
  to?: string;
}

export function fetchPartyLedger(partyId: string, query: PartyLedgerQuery = {}): Promise<LedgerReport> {
  const params = new URLSearchParams();
  if (query.accountCode) params.set("accountCode", query.accountCode);
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  return apiJson<LedgerReport>(`/accounting/reports/subsidiary-ledger/${partyId}?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Operational Profit (گزارش سود عملیاتی)
// ---------------------------------------------------------------------------

export interface ProfitRow {
  eventId: string;
  journalEntryId: string;
  sourceEntityType: string;
  sourceDocumentId: string;
  entryDate: string;
  eventType: string;
  customerId: string | null;
  customerName: string | null;
  salespersonUserId: string | null;
  productVariantId: string | null;
  variantNameFa: string | null;
  supplierId: string | null;
  revenue: string;
  cogs: string;
  grossProfit: string;
  marginPct: string | null;
}

export interface ProfitReport {
  rows: ProfitRow[];
  totals: { revenue: string; cogs: string; grossProfit: string };
}

export interface ProfitQuery {
  from?: string;
  to?: string;
  customerId?: string;
  productVariantId?: string;
}

export function fetchOperationalProfit(query: ProfitQuery = {}): Promise<ProfitReport> {
  const params = new URLSearchParams();
  for (const key of ["from", "to", "customerId", "productVariantId"] as const) {
    if (query[key]) params.set(key, String(query[key]));
  }
  return apiJson<ProfitReport>(`/accounting/reports/operational-profit?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Inventory Valuation (ارزش‌گذاری موجودی)
// ---------------------------------------------------------------------------

export interface ValuationRow {
  variant: { id: string; sku: string; nameFa: string };
  templateNameFa: string;
  categoryNameFa: string | null;
  brandNameFa: string | null;
  warehouseNameFa: string | null;
  uomSymbol: string | null;
  quantity: string;
  unitCost: string | null;
  totalValue: string;
  negative: boolean;
}

export interface ValuationReport {
  asOf: string;
  rows: ValuationRow[];
  totals: { grandTotalValue: string; pageTotalValue: string; grandQuantity: string };
  page: number;
  pageSize: number;
  total: number;
}

export interface ValuationQuery {
  warehouseId?: string;
  search?: string;
  page?: number;
  pageSize?: number;
}

export function fetchInventoryValuation(query: ValuationQuery = {}): Promise<ValuationReport> {
  const params = new URLSearchParams();
  if (query.warehouseId) params.set("warehouseId", query.warehouseId);
  if (query.search) params.set("search", query.search);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 25));
  return apiJson<ValuationReport>(`/accounting/reports/inventory-valuation?${params.toString()}`);
}

// ---------------------------------------------------------------------------
// Journal entry drill-down
// ---------------------------------------------------------------------------

export interface JournalEntryDetail {
  id: string;
  entryNumber: string;
  entryDate: string;
  journalCode: string;
  documentType: string | null;
  description: string | null;
  status: "DRAFT" | "POSTED" | "REVERSED" | "CANCELLED";
  reversedByEntryId: string | null;
  reversalOf: { id: string; entryNumber: string } | null;
  reversedBy: { id: string; entryNumber: string } | null;
  lines: Array<{
    id: string;
    accountCode: string;
    accountName: string;
    partyId: string | null;
    partyNameFa: string | null;
    description: string | null;
    debit: string;
    credit: string;
  }>;
}

export function fetchJournalEntry(id: string): Promise<JournalEntryDetail> {
  return apiJson<JournalEntryDetail>(`/accounting/reports/journal-entries/${id}`);
}

// ---------------------------------------------------------------------------
// Opening balances (افتتاحیه)
// ---------------------------------------------------------------------------

/** One staged opening-balance ROW (the service stores row-level entries). */
export interface OpeningBalanceEntry {
  id: string;
  accountCode: string;
  partyId: string | null;
  partyName: string | null;
  productVariantId: string | null;
  quantity: string | null;
  unitCost: string | null;
  debit: string;
  credit: string;
  status: "STAGED" | "POSTED";
  journalEntryId: string | null;
  note: string | null;
  createdAt: string;
}

/** Staged opening-balance rows (plain array, not {items,total}). */
export function fetchOpeningBalances(): Promise<OpeningBalanceEntry[]> {
  return apiJson(`/accounting/opening-balance`);
}

export interface OpeningRowInput {
  accountCode: string;
  partyId?: string | null;
  partyName?: string | null;
  productVariantId?: string | null;
  quantity?: string | null;
  unitCost?: string | null;
  debit?: string | null;
  credit?: string | null;
  note?: string | null;
}

export function stageOpeningBalances(rows: OpeningRowInput[]): Promise<unknown> {
  return apiJson(`/accounting/opening-balance/stage`, {
    method: "POST",
    body: JSON.stringify({ rows }),
  });
}

export function generateOpeningEntry(entryDate?: string): Promise<unknown> {
  return apiJson(`/accounting/opening-balance/generate`, {
    method: "POST",
    body: JSON.stringify(entryDate ? { entryDate } : {}),
  });
}

// ---------------------------------------------------------------------------
// Fiscal years & periods (سال مالی)
// ---------------------------------------------------------------------------

export interface FiscalPeriod {
  id: string;
  code: string;
  nameFa: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
}

export interface FiscalYear {
  id: string;
  code: string;
  nameFa: string;
  startDate: string;
  endDate: string;
  status: "OPEN" | "CLOSED";
  periods: FiscalPeriod[];
}

export function fetchFiscalYears(): Promise<FiscalYear[]> {
  return apiJson<FiscalYear[]>(`/fiscal-years`);
}

export interface CreateFiscalYearInput {
  code: string;
  nameFa: string;
  startDate: string; // ISO date
  endDate: string; // ISO date
  generateMonthlyPeriods?: boolean;
}

export function createFiscalYear(input: CreateFiscalYearInput): Promise<FiscalYear> {
  return apiJson(`/fiscal-years`, { method: "POST", body: JSON.stringify(input) });
}

export function closeFiscalYear(id: string): Promise<FiscalYear> {
  return apiJson(`/fiscal-years/${id}/close`, { method: "POST" });
}

export function reopenFiscalYear(id: string): Promise<FiscalYear> {
  return apiJson(`/fiscal-years/${id}/reopen`, { method: "POST" });
}

export function setFiscalPeriodStatus(
  yearId: string,
  periodId: string,
  status: "OPEN" | "CLOSED",
): Promise<FiscalPeriod> {
  return apiJson(`/fiscal-years/${yearId}/periods/${periodId}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

// ---------------------------------------------------------------------------
// Accounting events & posting rules (Phase 7B endpoints, posting.manage UI)
// ---------------------------------------------------------------------------

export type AccountingEventType =
  | "SALES_COMPLETED_LOADING"
  | "PURCHASE_FULFILLED"
  | "GOODS_RECEIPT_CONFIRMED"
  | "INVENTORY_REVERSAL"
  | "PAYMENT_RECEIVED"
  | "PAYMENT_MADE";

export const EVENT_TYPE_LABELS: Record<string, string> = {
  SALES_COMPLETED_LOADING: "شناسایی فروش (بارگیری)",
  PURCHASE_FULFILLED: "ثبت خرید",
  GOODS_RECEIPT_CONFIRMED: "رسید کالا",
  INVENTORY_REVERSAL: "برگشت موجودی",
  PAYMENT_RECEIVED: "دریافت",
  PAYMENT_MADE: "پرداخت",
};

export const EVENT_STATUS_LABELS: Record<string, string> = {
  POSTED: "ثبت‌شده",
  FAILED: "ناموفق",
  SKIPPED: "ردشده",
};

export interface AccountingEventRow {
  id: string;
  eventType: string;
  status: "POSTED" | "FAILED" | "SKIPPED";
  sourceEntityType: string;
  sourceEntityId: string;
  journalEntryId: string | null;
  error: string | null;
  idempotencyKey: string;
  createdAt: string;
}

export interface EventsQuery {
  status?: "POSTED" | "FAILED" | "SKIPPED";
  eventType?: string;
  page?: number;
  pageSize?: number;
}

export function fetchAccountingEvents(query: EventsQuery = {}): Promise<Paginated<AccountingEventRow>> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.eventType) params.set("eventType", query.eventType);
  params.set("page", String(query.page ?? 1));
  params.set("pageSize", String(query.pageSize ?? 20));
  return apiJson<Paginated<AccountingEventRow>>(`/accounting/events?${params.toString()}`);
}

export function retryAccountingEvent(id: string): Promise<{ status: string; error: string | null }> {
  return apiJson(`/accounting/events/${id}/post`, { method: "POST" });
}

export interface PostingRuleLine {
  id: string;
  side: "DEBIT" | "CREDIT";
  accountCode: string;
  measure: string;
  memo: string | null;
  order: number;
}

export interface PostingRule {
  id: string;
  code: string;
  nameFa: string;
  eventType: string;
  enabled: boolean;
  lines: PostingRuleLine[];
}

export function fetchPostingRules(): Promise<PostingRule[]> {
  return apiJson<PostingRule[]>(`/accounting/rules`);
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

export interface Paginated<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

const FA_ERROR_MESSAGES: Record<string, string> = {
  ACCOUNT_NOT_FOUND: "حساب یافت نشد.",
  JOURNAL_ENTRY_NOT_FOUND: "سند حسابداری یافت نشد.",
  FISCAL_YEAR_NOT_FOUND: "سال مالی یافت نشد.",
  FISCAL_YEAR_ALREADY_CLOSED: "این سال مالی قبلاً بسته شده است.",
  FISCAL_YEAR_ALREADY_OPEN: "این سال مالی از قبل باز است.",
  FISCAL_YEAR_CLOSED: "سال مالی بسته است و این عملیات مجاز نیست.",
  PERIOD_CLOSED: "دوره مالی بسته است و ثبت در آن مجاز نیست.",
  PERIOD_NOT_FOUND: "دوره مالی یافت نشد.",
  FISCAL_YEAR_EXISTS: "سال مالی با این کد قبلاً ثبت شده است.",
  INVALID_FISCAL_RANGE: "بازه سال مالی نامعتبر است.",
  OPENING_BALANCE_UNBALANCED: "جمع بدهکار و بستانکار افتتاحیه برابر نیست.",
  OPENING_ALREADY_GENERATED: "سند افتتاحیه قبلاً صادر شده است.",
  ACCOUNTING_EVENT_NOT_FOUND: "رویداد حسابداری یافت نشد.",
  NO_POSTING_RULE: "قاعده ثبت برای این رویداد تعریف نشده است.",
};

/** Persian error message for accounting API failures. */
export function accountingErrorMessage(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  for (const [key, fa] of Object.entries(FA_ERROR_MESSAGES)) {
    if (message.includes(key)) return fa;
  }
  return message || "خطایی در دریافت داده‌های حسابداری رخ داد.";
}
