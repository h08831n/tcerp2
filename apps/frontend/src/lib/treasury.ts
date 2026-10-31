import { apiJson } from "@/lib/api";

// ───────────────────────── types ─────────────────────────

export interface BankAccountDto {
  id: string;
  name: string;
  bankName: string;
  accountNumber: string | null;
  iban: string | null;
  currency: string;
  isActive: boolean;
}

export interface BankStatementRow {
  id: string;
  date: string;
  description: string | null;
  debit: number | string | null;
  credit: number | string | null;
  balance: number | string | null;
  [key: string]: unknown;
}

export interface CheckDto {
  id: string;
  direction: "INCOMING" | "OUTGOING";
  checkNumber: string;
  bankName: string | null;
  partyId: string | null;
  amount: number;
  issueDate: string | null;
  dueDate: string;
  status:
    | "REGISTERED"
    | "PENDING"
    | "DEPOSITED"
    | "CLEARED"
    | "PAID"
    | "BOUNCED"
    | "CANCELLED";
  description: string | null;
  createdAt: string;
}

// ───────────────────────── bank accounts ─────────────────────────

export function fetchBankAccounts(): Promise<BankAccountDto[]> {
  return apiJson<BankAccountDto[]>("/treasury/bank-accounts");
}

export function createBankAccount(body: {
  name: string;
  bankName: string;
  accountNumber?: string;
  iban?: string;
  currency?: string;
}): Promise<BankAccountDto> {
  return apiJson("/treasury/bank-accounts", { method: "POST", body: JSON.stringify(body) });
}

export function fetchBankStatement(
  id: string,
  from?: string,
  to?: string,
): Promise<BankStatementRow[]> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const q = params.toString();
  return apiJson<BankStatementRow[]>(`/treasury/bank-accounts/${id}/statement${q ? `?${q}` : ""}`);
}

// ───────────────────────── receipts / payments / transfers ─────────────────────────

export function createReceipt(body: {
  bankAccountId: string;
  partyId?: string;
  amount: number;
  date?: string;
  description?: string;
}): Promise<unknown> {
  return apiJson("/treasury/receipts", { method: "POST", body: JSON.stringify(body) });
}

export function createPayment(body: {
  bankAccountId: string;
  partyId?: string;
  amount: number;
  date?: string;
  description?: string;
}): Promise<unknown> {
  return apiJson("/treasury/payments", { method: "POST", body: JSON.stringify(body) });
}

export function createTransfer(body: {
  sourceBankAccountId: string;
  destinationBankAccountId: string;
  amount: number;
  fee?: number;
  transferDate?: string;
  description?: string;
}): Promise<unknown> {
  return apiJson("/treasury/transfers", { method: "POST", body: JSON.stringify(body) });
}

// ───────────────────────── checks ─────────────────────────

export function fetchChecks(filter?: {
  status?: string;
  direction?: string;
}): Promise<CheckDto[]> {
  const params = new URLSearchParams();
  if (filter?.status) params.set("status", filter.status);
  if (filter?.direction) params.set("direction", filter.direction);
  const q = params.toString();
  return apiJson<CheckDto[]>(`/treasury/checks${q ? `?${q}` : ""}`);
}

export function registerCheck(
  direction: "INCOMING" | "OUTGOING",
  body: {
    checkNumber: string;
    partyId?: string;
    amount: number;
    dueDate: string;
    issueDate?: string;
    bankName?: string;
    description?: string;
  },
): Promise<CheckDto> {
  return apiJson(`/treasury/checks/${direction.toLowerCase()}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function checkTransition(
  id: string,
  action: "pending" | "deposit" | "clear" | "pay" | "bounce" | "cancel",
  bankAccountId?: string,
): Promise<CheckDto> {
  const body = bankAccountId ? { bankAccountId } : {};
  return apiJson<CheckDto>(`/treasury/checks/${id}/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}
