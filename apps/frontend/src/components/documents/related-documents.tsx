"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { faDigits } from "@/lib/format";
import {
  DOCUMENT_TYPE_LABELS,
  RELATION_TYPE_LABELS,
  documentHref,
  fetchDocumentRelations,
  type DocumentRelationType,
  type DocumentType,
  type RelationsResponse,
} from "@/lib/document-flow";

/** List page for a related document group. */
function groupListHref(type: string): string {
  return documentHref(type);
}

/**
 * «اسناد مرتبط» card (REQUIREMENTS §13): counts per (type, relation) with
 * clickable navigation to the target lists and labelled links to each
 * related document.
 */
export function RelatedDocumentsCard({
  entityType,
  entityId,
  title = "اسناد مرتبط",
}: {
  entityType: string;
  entityId: string;
  title?: string;
}) {
  const [data, setData] = useState<RelationsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchDocumentRelations(entityType, entityId)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError("خطا در دریافت اسناد مرتبط");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [entityType, entityId]);

  const hasRelations = Boolean(data && data.relations.length > 0);

  return (
    <section
      aria-label={title}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      {loading ? (
        <p className="mt-2 text-xs text-slate-400">در حال بارگذاری…</p>
      ) : error ? (
        <p className="mt-2 text-xs text-red-600">{error}</p>
      ) : !hasRelations ? (
        <p className="mt-2 text-xs text-slate-400">سند مرتبطی ثبت نشده است.</p>
      ) : (
        <ul className="mt-3 space-y-2">
          {data!.relations.map((group) => {
            const typeLabel =
              DOCUMENT_TYPE_LABELS[group.type as DocumentType] ?? group.type;
            const relationLabel =
              RELATION_TYPE_LABELS[group.relationType as DocumentRelationType] ??
              group.relationType;
            return (
              <li
                key={`${group.type}:${group.relationType}`}
                className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-slate-600">
                    {typeLabel}
                    <span className="mx-1 text-slate-300">·</span>
                    <span className="text-slate-400">{relationLabel}</span>
                  </span>
                  <Link
                    href={groupListHref(group.type)}
                    className="inline-flex items-center gap-1 rounded-md border border-primary-200 bg-primary-50 px-2 py-0.5 text-[11px] font-bold text-primary-700 transition-colors hover:bg-primary-100"
                    aria-label={`مشاهده ${faDigits(group.count)} ${typeLabel}`}
                  >
                    {faDigits(group.count)} مورد
                  </Link>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {group.items.map((item) => (
                    <Link
                      key={item.id}
                      href={documentHref(group.type, item.id)}
                      className="rounded border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-700 transition-colors hover:border-primary-300 hover:text-primary-700"
                      dir="auto"
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
