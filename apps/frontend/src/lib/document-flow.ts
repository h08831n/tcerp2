/**
 * Document Flow navigation (Phase 4, REQUIREMENTS §13).
 * Contract source of truth: apps/backend/src/document-flow/document-flow.controller.ts
 * GET /documents/:type/:id/relations — the "Related Documents" panel.
 */

import { apiJson } from "@/lib/api";

export const DOCUMENT_TYPES = [
  "sales_document",
  "purchase_document",
  "price_request",
  "lead",
  "opportunity",
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export type DocumentRelationType = "CREATED_FROM" | "GENERATED_FROM" | "RELATED" | "BASED_ON";

export const DOCUMENT_TYPE_LABELS: Record<DocumentType | "loading", string> = {
  sales_document: "سند فروش",
  purchase_document: "سند خرید",
  price_request: "درخواست قیمت",
  lead: "سرنخ",
  opportunity: "فرصت فروش",
  // Phase 6 placeholder group (count 0) so the UI slot stays stable.
  loading: "بارگیری‌ها",
};

export const RELATION_TYPE_LABELS: Record<DocumentRelationType, string> = {
  CREATED_FROM: "ایجادشده از",
  GENERATED_FROM: "تولیدشده از",
  RELATED: "مرتبط",
  BASED_ON: "مبتنی بر",
};

export interface RelatedGroup {
  type: string;
  relationType: string;
  count: number;
  items: { id: string; label: string; relationType: string; createdAt: string }[];
}

export interface RelationsResponse {
  relations: RelatedGroup[];
  totals: Record<string, number>;
}

export function fetchDocumentRelations(type: string, id: string): Promise<RelationsResponse> {
  return apiJson<RelationsResponse>(`/documents/${type}/${id}/relations`);
}

/** Detail-page route for a related document (list page when no detail). */
export function documentHref(type: string, id?: string): string {
  switch (type) {
    case "sales_document":
      return id ? `/sales/${id}` : "/sales";
    case "purchase_document":
      return id ? `/purchases/${id}` : "/purchases";
    case "price_request":
      return "/price-requests";
    case "lead":
      return "/crm/leads";
    case "opportunity":
      return "/crm/opportunities";
    default:
      return "/dashboard";
  }
}
