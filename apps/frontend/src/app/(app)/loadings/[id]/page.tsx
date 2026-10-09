"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { jalaliDateTime } from "@/lib/format";
import { fetchDocumentRelations } from "@/lib/document-flow";
import {
  LOADING_STATUS_BADGE_CLASSES,
  LOADING_STATUS_LABELS,
  cancelLoading,
  confirmLoading,
  decideDriverInfoRelease,
  fetchLoading,
  loadingErrorMessage,
  resolveLoadingReferences,
  type LoadingDetail,
} from "@/lib/loading";

interface RelatedGroup {
  type: string;
  relationType: string;
  count: number;
  items: { id: string; label: string; href?: string }[];
}

function PartyCard({
  title,
  party,
  hidden,
}: {
  title: string;
  party: LoadingDetail["driver"];
  hidden: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <h3 className="mb-2 text-xs font-bold text-slate-600">{title}</h3>
      {hidden || !party ? (
        <p className="text-xs text-slate-400">—</p>
      ) : (
        <div>
          <div className="text-sm font-medium text-slate-800">{party.nameFa}</div>
          {party.phones.length > 0 && (
            <div className="mt-1 space-y-0.5">
              {party.phones.map((p, i) => (
                <div key={i} className="text-xs tabular-nums text-slate-600" dir="ltr">
                  {p.rawValue}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function LoadingDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [loading, setLoading] = useState<LoadingDetail | null>(null);
  const [related, setRelated] = useState<RelatedGroup[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [releaseNote, setReleaseNote] = useState("");
  const [showReleaseModal, setShowReleaseModal] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await fetchLoading(id);
      setLoading(detail);
      try {
        const rel = await fetchDocumentRelations("loading", id);
        setRelated(rel.relations as RelatedGroup[]);
      } catch {
        setRelated([]);
      }
    } catch (e) {
      setError(loadingErrorMessage(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (fn: () => Promise<LoadingDetail>) => {
    setBusy(true);
    setError(null);
    try {
      setLoading(await fn());
    } catch (e) {
      setError(loadingErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (error && !loading) {
    return <div className="rounded-md border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  }
  if (!loading) {
    return <p className="text-sm text-slate-500">در حال بارگذاری…</p>;
  }

  const hiddenDriver = loading.driverInfoRestricted && loading.driver === null;
  const pendingApproval = loading.approvals.find((a) => a.status === "PENDING");

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-slate-800">
            بارگیری {jalaliDateTime(loading.loadingDate)}
          </h1>
          <span className={`mt-1 inline-block rounded px-2 py-0.5 text-xs font-medium ${LOADING_STATUS_BADGE_CLASSES[loading.status]}`}>
            {LOADING_STATUS_LABELS[loading.status]}
          </span>
        </div>
        <div className="flex gap-2">
          {loading.status === "DRAFT" && (
            <>
              <Button variant="primary" disabled={busy} onClick={() => void act(() => confirmLoading(id))}>
                تأیید بارگیری
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void act(() => cancelLoading(id))}>
                لغو
              </Button>
            </>
          )}
          {loading.driverInfoRestricted && loading.driver === null && pendingApproval && (
            <Button variant="secondary" onClick={() => setShowReleaseModal(true)}>
              افشای اطلاعات راننده (مدیر)
            </Button>
          )}
        </div>
      </div>

      {loading.driverInfoRestricted && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          اطلاعات راننده/ناقل تا تأیید مدیر مخفی است (مانده حساب مشتری).
        </div>
      )}

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <h3 className="mb-2 text-xs font-bold text-slate-600">مشتری</h3>
          {loading.customer ? (
            <Link href={`/parties/${loading.customer.id}`} className="text-sm text-sky-700 hover:underline">
              {loading.customer.nameFa}
            </Link>
          ) : (
            <span className="text-xs text-slate-400">—</span>
          )}
        </div>
        <PartyCard title="راننده" party={loading.driver} hidden={hiddenDriver} />
        <PartyCard title="ناقل" party={loading.carrier} hidden={hiddenDriver} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-700">خطوط</h2>
        <div className="overflow-hidden rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="px-3 py-2 text-right">کالا</th>
                <th className="px-3 py-2 text-center">مقدار</th>
                <th className="px-3 py-2 text-right">تخصیص‌ها</th>
              </tr>
            </thead>
            <tbody>
              {loading.lines.map((l) => (
                <tr key={l.id} className="border-t border-slate-100">
                  <td className="px-3 py-2">
                    <LoadingLineLabel loadingId={id} line={l} />
                  </td>
                  <td className="px-3 py-2 text-center tabular-nums">{l.actualQuantity}</td>
                  <td className="px-3 py-2">
                    {l.allocations.length === 0 ? (
                      <span className="text-xs text-slate-400">بدون تخصیص</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {l.allocations.map((a) => (
                          <LoadingAllocationLabel key={a.id} loadingId={id} allocation={a} />
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-bold text-slate-700">اسناد مرتبط</h2>
        <div className="flex flex-wrap gap-2">
          {related.filter((r) => r.count > 0).length === 0 && (
            <span className="text-xs text-slate-400">سند مرتبطی ثبت نشده</span>
          )}
          {related
            .filter((r) => r.count > 0)
            .map((g) => (
              <div key={`${g.type}:${g.relationType}`} className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                <div className="text-xs text-slate-500">
                  {g.type === "sales_document" ? "فروش" : g.type === "purchase_document" ? "خرید" : g.type} ({g.relationType})
                </div>
                <div className="text-sm font-bold text-sky-700">{g.count}</div>
                <div className="mt-1 flex flex-col gap-0.5">
                  {g.items.slice(0, 3).map((it) => (
                    <span key={it.id} className="text-xs text-slate-600">
                      {it.label}
                    </span>
                  ))}
                </div>
              </div>
            ))}
        </div>
      </section>

      {showReleaseModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40"
          role="dialog"
          aria-label="افشای اطلاعات راننده"
          onClick={() => setShowReleaseModal(false)}
        >
          <div
            className="w-96 rounded-lg bg-white p-4 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-sm font-bold text-slate-800">تصمیم درباره افشای اطلاعات راننده</h3>
            <textarea
              className="w-full rounded-md border border-slate-300 p-2 text-sm"
              rows={3}
              placeholder="یادداشت (اختیاری)"
              value={releaseNote}
              onChange={(e) => setReleaseNote(e.target.value)}
            />
            <div className="mt-3 flex gap-2">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  decideDriverInfoRelease(id, "APPROVED", releaseNote || undefined)
                    .then(() => (setShowReleaseModal(false), void load()))
                    .catch((e) => setError(loadingErrorMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                تأیید و افشا
              </Button>
              <Button
                variant="danger"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  decideDriverInfoRelease(id, "REJECTED", releaseNote || undefined)
                    .then(() => (setShowReleaseModal(false), void load()))
                    .catch((e) => setError(loadingErrorMessage(e)))
                    .finally(() => setBusy(false));
                }}
              >
                رد درخواست
              </Button>
              <Button variant="ghost" onClick={() => setShowReleaseModal(false)}>
                بستن
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Resolves variant labels for the loading's lines via related documents. */
function useLoadingReferences(loadingId: string) {
  const [refs, setRefs] = useState<Awaited<ReturnType<typeof resolveLoadingReferences>> | null>(null);
  useEffect(() => {
    resolveLoadingReferences(loadingId)
      .then(setRefs)
      .catch(() => setRefs(null));
  }, [loadingId]);
  return refs;
}

function LoadingLineLabel({
  loadingId,
  line,
}: {
  loadingId: string;
  line: { id: string; productVariantId: string };
}) {
  const refs = useLoadingReferences(loadingId);
  const fromRef = line.productVariantId ? refs?.variantLabels.get(line.productVariantId) : undefined;
  const label = fromRef ? `${fromRef.nameFa}${fromRef.sku ? ` — ${fromRef.sku}` : ""}` : "کالا";
  return <span className="text-sm text-slate-800">{label}</span>;
}

function LoadingAllocationLabel({
  loadingId,
  allocation,
}: {
  loadingId: string;
  allocation: { id: string; salesLineId: string | null; purchaseLineId: string | null; allocatedQuantity: string };
}) {
  const refs = useLoadingReferences(loadingId);
  const targetId = allocation.salesLineId ?? allocation.purchaseLineId;
  const ref = targetId ? refs?.lineRefs.get(`${allocation.salesLineId ? "S" : "P"}:${targetId}`) : undefined;
  const kind = allocation.salesLineId ? "فروش" : "خرید";
  const target = ref ? `${ref.kind === "SALES" ? "SD" : "PO"} ${ref.documentNumber}` : targetId?.slice(0, 8) ?? "—";
  return (
    <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
      {ref ? (
        <Link href={ref.href} className="text-sky-700 hover:underline">
          {kind}: {target}
        </Link>
      ) : (
        <span>
          {kind}: {target}
        </span>
      )}{" "}
      ({allocation.allocatedQuantity})
    </span>
  );
}
