"use client";

import {
  PARTY_ROLE_LABELS,
  PARTY_TYPE_LABELS,
  type PartyRole,
  type PartyType,
  scoreLevelLabel,
} from "@/lib/party";

const ROLE_BADGE_CLASSES: Record<PartyRole, string> = {
  CUSTOMER: "bg-primary-50 text-primary-700 border-primary-200",
  SUPPLIER: "bg-emerald-50 text-emerald-700 border-emerald-200",
  DRIVER: "bg-amber-50 text-amber-700 border-amber-200",
  CARRIER: "bg-violet-50 text-violet-700 border-violet-200",
  PARTNER: "bg-sky-50 text-sky-700 border-sky-200",
};

export function RoleBadge({ role }: { role: PartyRole }) {
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${ROLE_BADGE_CLASSES[role] ?? "bg-slate-100 text-slate-600 border-slate-200"}`}
    >
      {PARTY_ROLE_LABELS[role] ?? role}
    </span>
  );
}

export function TypeBadge({ type }: { type: PartyType }) {
  return (
    <span className="inline-flex items-center rounded border border-slate-200 bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600">
      {PARTY_TYPE_LABELS[type] ?? type}
    </span>
  );
}

const LEVEL_BADGE_CLASSES: Record<string, string> = {
  A: "bg-amber-100 text-amber-800 border-amber-300",
  GOLD: "bg-amber-100 text-amber-800 border-amber-300",
  PLATINUM: "bg-slate-800 text-white border-slate-800",
  B: "bg-slate-200 text-slate-700 border-slate-300",
  SILVER: "bg-slate-200 text-slate-700 border-slate-300",
  C: "bg-orange-100 text-orange-800 border-orange-200",
  BRONZE: "bg-orange-100 text-orange-800 border-orange-200",
  D: "bg-slate-100 text-slate-500 border-slate-200",
  REGULAR: "bg-slate-100 text-slate-500 border-slate-200",
};

export function ScoreBadge({
  score,
  level,
}: {
  score: number | null | undefined;
  level: string | null | undefined;
}) {
  if (score === null || score === undefined) {
    return <span className="text-xs text-slate-400">—</span>;
  }
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-bold ${
        LEVEL_BADGE_CLASSES[level ?? ""] ?? "bg-slate-100 text-slate-600 border-slate-200"
      }`}
      title={`سطح: ${scoreLevelLabel(level)}`}
    >
      {score}
      <span className="font-medium">{scoreLevelLabel(level)}</span>
    </span>
  );
}

export function StatusBadge({ archived }: { archived: boolean }) {
  return archived ? (
    <span className="inline-flex items-center rounded border border-red-200 bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">
      بایگانی
    </span>
  ) : (
    <span className="inline-flex items-center rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700">
      فعال
    </span>
  );
}
