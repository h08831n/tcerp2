"use client";

import {
  LEAD_STATUS_LABELS,
  OPPORTUNITY_STATUS_LABELS,
  type LeadStatus,
  type OpportunityStatus,
} from "@/lib/crm";
import {
  PRICE_REQUEST_STATUS_BADGE_CLASSES,
  PRICE_REQUEST_STATUS_LABELS,
  type PriceRequestStatus,
} from "@/lib/price-request";
import {
  PURCHASE_STATUS_BADGE_CLASSES,
  PURCHASE_STATUS_LABELS,
  type PurchaseStatus,
} from "@/lib/purchase";
import {
  SALES_STATUS_BADGE_CLASSES,
  SALES_STATUS_LABELS,
  type SalesDocumentStatus,
} from "@/lib/sales";

function Badge({ label, classes }: { label: string; classes: string }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded border px-1.5 py-0.5 text-[11px] font-medium ${classes}`}
    >
      {label}
    </span>
  );
}

export function SaleStatusBadge({ status }: { status: SalesDocumentStatus }) {
  return <Badge label={SALES_STATUS_LABELS[status] ?? status} classes={SALES_STATUS_BADGE_CLASSES[status] ?? "border-slate-200 bg-slate-50 text-slate-600"} />;
}

export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  return <Badge label={PURCHASE_STATUS_LABELS[status] ?? status} classes={PURCHASE_STATUS_BADGE_CLASSES[status] ?? "border-slate-200 bg-slate-50 text-slate-600"} />;
}

export function PriceRequestStatusBadge({ status }: { status: PriceRequestStatus }) {
  return <Badge label={PRICE_REQUEST_STATUS_LABELS[status] ?? status} classes={PRICE_REQUEST_STATUS_BADGE_CLASSES[status] ?? "border-slate-200 bg-slate-50 text-slate-600"} />;
}

const LEAD_BADGE_CLASSES: Record<LeadStatus, string> = {
  NEW: "border-sky-200 bg-sky-50 text-sky-700",
  CONTACTED: "border-indigo-200 bg-indigo-50 text-indigo-700",
  QUALIFIED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  LOST: "border-rose-200 bg-rose-50 text-rose-700",
};

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  return <Badge label={LEAD_STATUS_LABELS[status] ?? status} classes={LEAD_BADGE_CLASSES[status] ?? "border-slate-200 bg-slate-50 text-slate-600"} />;
}

const OPPORTUNITY_BADGE_CLASSES: Record<OpportunityStatus, string> = {
  OPEN: "border-amber-200 bg-amber-50 text-amber-700",
  QUALIFIED: "border-sky-200 bg-sky-50 text-sky-700",
  QUOTED: "border-indigo-200 bg-indigo-50 text-indigo-700",
  WON: "border-emerald-200 bg-emerald-50 text-emerald-700",
  LOST: "border-rose-200 bg-rose-50 text-rose-700",
};

export function OpportunityStatusBadge({ status }: { status: OpportunityStatus }) {
  return <Badge label={OPPORTUNITY_STATUS_LABELS[status] ?? status} classes={OPPORTUNITY_BADGE_CLASSES[status] ?? "border-slate-200 bg-slate-50 text-slate-600"} />;
}
