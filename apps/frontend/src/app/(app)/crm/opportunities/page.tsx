"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { OpportunityStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali, toNum, thousandSeparate } from "@/lib/format";
import { parseDecimalInput } from "@/lib/product";
import {
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUS_LABELS,
  OPPORTUNITY_TRANSITIONS,
  crmErrorMessage,
  createOpportunity,
  fetchLostReasons,
  fetchOpportunities,
  fetchOpportunity,
  updateOpportunity,
  userDisplayName,
  type LostReasonDto,
  type OpportunityDto,
  type OpportunityQuery,
  type OpportunityStatus,
} from "@/lib/crm";

const PAGE_SIZE = 20;

function customerMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  return { id, label: typeof item.nameFa === "string" && item.nameFa ? item.nameFa : id };
}

function userMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const name = [item.firstName, item.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();
  return { id, label: name || (typeof item.username === "string" ? item.username : id) };
}

interface OpportunityFormState {
  title: string;
  description: string;
  estimatedAmount: string;
  estimatedTonnage: string;
  source: string;
  customer: EntityOption | null;
  salesperson: EntityOption | null;
}

const EMPTY_FORM: OpportunityFormState = {
  title: "",
  description: "",
  estimatedAmount: "",
  estimatedTonnage: "",
  source: "",
  customer: null,
  salesperson: null,
};

export default function OpportunitiesPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<OpportunityStatus | "">("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<{ items: OpportunityDto[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Detail drawer
  const [detail, setDetail] = useState<OpportunityDto | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Status change (needs lostReasonId when → LOST)
  const [statusTarget, setStatusTarget] = useState<OpportunityStatus | "">("");
  const [lostReasons, setLostReasons] = useState<LostReasonDto[]>([]);
  const [lostReasonId, setLostReasonId] = useState("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);

  // Create form
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<OpportunityFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo<OpportunityQuery>(
    () => ({
      page,
      pageSize: PAGE_SIZE,
      search: search || undefined,
      status: status || undefined,
    }),
    [page, search, status],
  );

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchOpportunities(query)
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(crmErrorMessage(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  useEffect(() => load(), [load, reloadToken]);

  const openDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await fetchOpportunity(id));
    } catch (err) {
      setError(crmErrorMessage(err));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  async function openStatusChange(opportunity: OpportunityDto, target: OpportunityStatus) {
    setStatusTarget(target);
    setLostReasonId("");
    setStatusError(null);
    setDetail(opportunity);
    if (target === "LOST" && lostReasons.length === 0) {
      try {
        setLostReasons(await fetchLostReasons(true));
      } catch {
        /* reason list stays empty; backend will reject with LOST_REASON_REQUIRED */
      }
    }
  }

  async function handleStatusSave() {
    if (!detail || !statusTarget) return;
    setSavingStatus(true);
    setStatusError(null);
    try {
      await updateOpportunity(detail.id, {
        status: statusTarget,
        version: detail.version,
        ...(statusTarget === "LOST" ? { lostReasonId } : {}),
      });
      setDetail(null);
      setStatusTarget("");
      setReloadToken((token) => token + 1);
    } catch (err) {
      setStatusError(crmErrorMessage(err));
    } finally {
      setSavingStatus(false);
    }
  }

  async function handleCreate() {
    if (!form.customer) {
      setFormError("انتخاب مشتری الزامی است (نقش مشتری الزامی است).");
      return;
    }
    if (!form.salesperson) {
      setFormError("انتخاب فروشنده الزامی است.");
      return;
    }
    if (!form.title.trim()) {
      setFormError("عنوان فرصت الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const amount = parseDecimalInput(form.estimatedAmount);
      const tonnage = parseDecimalInput(form.estimatedTonnage);
      await createOpportunity({
        customerPartyId: form.customer.id,
        salespersonUserId: form.salesperson.id,
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        estimatedAmount: amount ? Number(amount) : undefined,
        estimatedTonnage: tonnage ? Number(tonnage) : undefined,
        source: form.source.trim() || undefined,
      });
      setFormOpen(false);
      setForm(EMPTY_FORM);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setFormError(crmErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const columns = useMemo<DataTableColumn<OpportunityDto>[]>(
    () => [
      {
        key: "title",
        header: "عنوان",
        render: (row) => <span className="font-medium text-slate-800">{row.title}</span>,
      },
      { key: "customer", header: "مشتری", render: (row) => row.customer?.nameFa ?? "—" },
      {
        key: "salesperson",
        header: "فروشنده",
        render: (row) => userDisplayName(row.salesperson),
      },
      {
        key: "estimatedAmount",
        header: "مبلغ تخمینی",
        align: "end",
        render: (row) => {
          const value = toNum(row.estimatedAmount);
          return value !== null ? (
            <span className="tabular-nums">{faDigits(thousandSeparate(value))}</span>
          ) : (
            <span className="text-slate-400">—</span>
          );
        },
      },
      {
        key: "estimatedTonnage",
        header: "تناژ تخمینی",
        align: "end",
        render: (row) => {
          const value = toNum(row.estimatedTonnage);
          return value !== null ? (
            <span className="tabular-nums">{faDigits(thousandSeparate(value))}</span>
          ) : (
            <span className="text-slate-400">—</span>
          );
        },
      },
      {
        key: "status",
        header: "وضعیت",
        align: "center",
        render: (row) => <OpportunityStatusBadge status={row.status} />,
      },
      {
        key: "createdAt",
        header: "تاریخ ایجاد",
        render: (row) => (
          <span className="tabular-nums text-slate-500">{jalali(row.createdAt)}</span>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "end",
        render: (row) => (
          <Button size="sm" variant="ghost" onClick={() => void openDetail(row.id)}>
            جزئیات
          </Button>
        ),
      },
    ],
    [openDetail],
  );

  const transitions = detail ? OPPORTUNITY_TRANSITIONS[detail.status] : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">فرصت‌های فروش</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            زنجیره وضعیت: باز ← واجد شرایط ← پیش‌فاکتورشده ← موفق / باخته
          </p>
        </div>
        <Button onClick={() => setFormOpen(true)} aria-label="ثبت فرصت جدید">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            className="h-4 w-4"
            aria-hidden="true"
          >
            <path d="M12 5v14M5 12h14" />
          </svg>
          فرصت جدید
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-64">
          <label htmlFor="opp-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (عنوان)
          </label>
          <Input
            id="opp-search"
            inputSize="sm"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="جستجو…"
            aria-label="جستجوی فرصت‌ها"
          />
        </div>
        <div className="w-40">
          <label htmlFor="opp-status" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="opp-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as OpportunityStatus | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {OPPORTUNITY_STATUSES.map((value) => (
              <option key={value} value={value}>
                {OPPORTUNITY_STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}{" "}
          <button type="button" className="font-bold underline" onClick={() => setReloadToken((t) => t + 1)}>
            تلاش مجدد
          </button>
        </div>
      )}

      <DataTable<OpportunityDto>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={loading}
        dense
        ariaLabel="فهرست فرصت‌های فروش"
        pagination={
          data
            ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }
            : null
        }
      />

      {/* Detail drawer */}
      {detail && (
        <div className="fixed inset-0 z-50">
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            onClick={() => setDetail(null)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setDetail(null);
            }}
            className="absolute inset-0 cursor-default bg-slate-900/40"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={`جزئیات فرصت ${detail.title}`}
            className="absolute inset-y-0 start-0 flex w-full max-w-md flex-col overflow-y-auto bg-white shadow-xl"
          >
            <div className="sticky top-0 flex items-center justify-between border-b border-slate-100 bg-white px-5 py-3">
              <h3 className="text-sm font-bold text-slate-800">{detail.title}</h3>
              <button
                type="button"
                onClick={() => setDetail(null)}
                aria-label="بستن (Esc)"
                className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  className="h-4 w-4"
                  aria-hidden="true"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-4 px-5 py-4">
              {statusError && (
                <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {statusError}
                </div>
              )}
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">مشتری</dt>
                  <dd className="font-medium text-slate-800">{detail.customer?.nameFa ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">فروشنده</dt>
                  <dd className="font-medium text-slate-800">{userDisplayName(detail.salesperson)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">وضعیت</dt>
                  <dd>
                    <OpportunityStatusBadge status={detail.status} />
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">مبلغ تخمینی</dt>
                  <dd className="tabular-nums text-slate-800">
                    {detail.estimatedAmount !== null
                      ? `${faDigits(thousandSeparate(Number(detail.estimatedAmount)))} ریال`
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">تناژ تخمینی</dt>
                  <dd className="tabular-nums text-slate-800">
                    {detail.estimatedTonnage !== null
                      ? faDigits(thousandSeparate(Number(detail.estimatedTonnage)))
                      : "—"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">منبع</dt>
                  <dd className="text-slate-800">{detail.source ?? "—"}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-slate-500">تاریخ ایجاد</dt>
                  <dd className="tabular-nums text-slate-800">{jalali(detail.createdAt)}</dd>
                </div>
              </dl>
              {detail.description && (
                <div className="rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2 text-xs text-slate-600">
                  {detail.description}
                </div>
              )}
              {detail.status === "LOST" && (
                <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                  دلیل باخت: {detail.lostReason?.nameFa ?? "—"}
                </div>
              )}

              {transitions.length > 0 && (
                <div className="border-t border-slate-100 pt-3">
                  <p className="mb-2 text-xs font-medium text-slate-600">تغییر وضعیت</p>
                  <div className="flex flex-wrap gap-2">
                    {transitions.map((target) => (
                      <Button
                        key={target}
                        size="sm"
                        variant={target === "LOST" ? "danger" : "secondary"}
                        onClick={() => void openStatusChange(detail, target)}
                      >
                        {OPPORTUNITY_STATUS_LABELS[target]}
                      </Button>
                    ))}
                  </div>
                  {statusTarget && (
                    <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
                      {statusTarget === "LOST" && (
                        <div>
                          <label htmlFor="opp-lost-reason" className="mb-1 block text-xs font-medium text-slate-600">
                            دلیل باخت *
                          </label>
                          <select
                            id="opp-lost-reason"
                            value={lostReasonId}
                            onChange={(event) => setLostReasonId(event.target.value)}
                            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
                          >
                            <option value="">انتخاب کنید…</option>
                            {lostReasons.map((reason) => (
                              <option key={reason.id} value={reason.id}>
                                {reason.nameFa}
                              </option>
                            ))}
                          </select>
                          {lostReasons.length === 0 && (
                            <p className="mt-1 text-[11px] text-amber-600">
                              فهرست دلایل بارگذاری نشده است؛ بدون دلیل، سرور درخواست را رد می‌کند.
                            </p>
                          )}
                        </div>
                      )}
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setStatusTarget("")}>
                          انصراف
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => void handleStatusSave()}
                          disabled={savingStatus || (statusTarget === "LOST" && !lostReasonId)}
                        >
                          {savingStatus ? "در حال ذخیره…" : "ذخیره"}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {/* Create opportunity */}
      <Modal
        open={formOpen}
        title="ثبت فرصت فروش جدید"
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleCreate()} disabled={saving}>
              {saving ? "در حال ثبت…" : "ثبت (Ctrl+Enter)"}
            </Button>
          </>
        }
      >
        <div
          className="space-y-3"
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.ctrlKey) {
              event.preventDefault();
              void handleCreate();
            }
          }}
        >
          {formError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {formError}
            </div>
          )}
          <div>
            <label htmlFor="opp-customer" className="mb-1 block text-xs font-medium text-slate-600">
              مشتری * (باید نقش مشتری داشته باشد)
            </label>
            <div id="opp-customer">
              <EntitySelector
                endpoint={(q) => `/parties?role=CUSTOMER&search=${encodeURIComponent(q)}&pageSize=10`}
                mapItem={customerMapItem}
                value={form.customer}
                onChange={(customer) => setForm((f) => ({ ...f, customer }))}
                placeholder="جستجوی مشتری…"
                ariaLabel="انتخاب مشتری فرصت"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-slate-600">فروشنده *</label>
            <EntitySelector
              endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
              mapItem={userMapItem}
              value={form.salesperson}
              onChange={(salesperson) => setForm((f) => ({ ...f, salesperson }))}
              placeholder="جستجوی کاربر…"
              ariaLabel="انتخاب فروشنده فرصت"
            />
          </div>
          <div>
            <label htmlFor="opp-title" className="mb-1 block text-xs font-medium text-slate-600">
              عنوان *
            </label>
            <Input
              id="opp-title"
              value={form.title}
              onChange={(event) => setForm((f) => ({ ...f, title: event.target.value }))}
              aria-label="عنوان فرصت"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="opp-amount" className="mb-1 block text-xs font-medium text-slate-600">
                مبلغ تخمینی (ریال)
              </label>
              <Input
                id="opp-amount"
                dir="ltr"
                inputMode="decimal"
                value={form.estimatedAmount}
                onChange={(event) => setForm((f) => ({ ...f, estimatedAmount: event.target.value }))}
                aria-label="مبلغ تخمینی"
              />
            </div>
            <div>
              <label htmlFor="opp-tonnage" className="mb-1 block text-xs font-medium text-slate-600">
                تناژ تخمینی
              </label>
              <Input
                id="opp-tonnage"
                dir="ltr"
                inputMode="decimal"
                value={form.estimatedTonnage}
                onChange={(event) => setForm((f) => ({ ...f, estimatedTonnage: event.target.value }))}
                aria-label="تناژ تخمینی"
              />
            </div>
          </div>
          <div>
            <label htmlFor="opp-desc" className="mb-1 block text-xs font-medium text-slate-600">
              توضیحات
            </label>
            <textarea
              id="opp-desc"
              rows={2}
              value={form.description}
              onChange={(event) => setForm((f) => ({ ...f, description: event.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              aria-label="توضیحات فرصت"
            />
          </div>
        </div>
      </Modal>

      {detailLoading && (
        <div className="fixed inset-x-0 bottom-4 flex justify-center">
          <span className="rounded-full bg-slate-800 px-4 py-1.5 text-xs text-white shadow">
            در حال بارگذاری جزئیات…
          </span>
        </div>
      )}
    </div>
  );
}
