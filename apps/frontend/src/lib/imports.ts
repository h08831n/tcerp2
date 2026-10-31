import { apiJson } from "@/lib/api";
import type { PaginatedResponse } from "@/lib/product";

export interface ImportJobDto {
  id: string;
  entityType: "PARTY" | "DAILY_PRICE" | "PRODUCT_VARIANT";
  fileName: string;
  status: "VALIDATED" | "RUNNING" | "COMPLETED" | "PARTIALLY_FAILED" | "FAILED" | "CANCELLED";
  totalRows: number;
  okCount: number;
  updatedCount: number;
  failedCount: number;
  duplicateCount: number;
  commitMode: "PER_ROW" | "BATCH";
  batchSize: number;
  columnMapping: Record<string, string>;
  createdAt: string;
  finishedAt: string | null;
  _count?: { rows: number };
}

export interface ImportRowDto {
  id: string;
  rowIndex: number;
  status: "PENDING" | "OK" | "FAILED" | "DUPLICATE";
  payload: Record<string, unknown>;
  error: string | null;
}

export function createImportJob(body: {
  entityType: "PARTY" | "DAILY_PRICE" | "PRODUCT_VARIANT";
  fileName?: string;
  csv?: string;
  xlsxBase64?: string;
  columnMapping?: Record<string, string>;
  updateMatched?: boolean;
  commitMode?: "PER_ROW" | "BATCH";
  batchSize?: number;
}): Promise<ImportJobDto> {
  return apiJson<ImportJobDto>("/imports", { method: "POST", body: JSON.stringify(body) });
}

export function fetchImportJobs(input: { page?: number; pageSize?: number } = {}): Promise<
  PaginatedResponse<ImportJobDto>
> {
  return apiJson<PaginatedResponse<ImportJobDto>>(
    `/imports?page=${input.page ?? 1}&pageSize=${input.pageSize ?? 20}`,
  );
}

export function fetchImportJob(id: string): Promise<ImportJobDto> {
  return apiJson<ImportJobDto>(`/imports/${id}`);
}

export function fetchImportRows(id: string): Promise<ImportRowDto[]> {
  return apiJson<ImportRowDto[]>(`/imports/${id}/rows`);
}

export function runImport(id: string): Promise<ImportJobDto> {
  return apiJson<ImportJobDto>(`/imports/${id}/run`, { method: "POST" });
}

export function cancelImport(id: string): Promise<{ success: boolean }> {
  return apiJson(`/imports/${id}/cancel`, { method: "POST" });
}
