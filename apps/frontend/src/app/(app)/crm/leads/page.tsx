"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { LeadStatusBadge } from "@/components/documents/status-badges";
import { faDigits, jalali } from "@/lib/format";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_TRANSITIONS,
  crmErrorMessage,
  createLead,
  fetchLeads,
  updateLead,
  type LeadDto,
  type LeadQuery,
  type LeadStatus,
} from "@/lib/crm";
import { fetchUsers } from "@/lib/party";

const PAGE_SIZE = 20;

function partyMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const label = typeof item.nameFa === "string" && item.nameFa ? item.nameFa : id;
  return { id, label };
}

/** Maps a user row to an option (list shape: {id, username}). */
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

interface LeadFormState {
  name: string;
  phone: string;
  source: string;
  campaign: string;
  media: string;
  referrer: string;
  notes: string;
  party: EntityOption | null;
  salesperson: EntityOption | null;
}

const EMPTY_FORM: LeadFormState = {
  name: "",
  phone: "",
  source: "",
  campaign: "",
  media: "",
  referrer: "",
  notes: "",
  party: null,
  salesperson: null,
};

export default function LeadsPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<LeadStatus | "">("");
  const [page, setPage] = useState(1);

  const [data, setData] = useState<{ items: LeadDto[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // Create form
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<LeadFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Status edit
  const [editing, setEditing] = useState<LeadDto | null>(null);
  const [nextStatus, setNextStatus] = useState<LeadStatus | "">("");
  const [statusError, setStatusError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo<LeadQuery>(
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
    fetchLeads(query)
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

  async function handleCreate() {
    if (!form.name.trim()) {
      setFormError("نام سرنخ الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await createLead({
        name: form.name.trim(),
        phone: form.phone.trim() || undefined,
        source: form.source.trim() || undefined,
        campaign: form.campaign.trim() || undefined,
        media: form.media.trim() || undefined,
        referrer: form.referrer.trim() || undefined,
        notes: form.notes.trim() || undefined,
        partyId: form.party?.id,
        assignedSalespersonId: form.salesperson?.id,
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

  function openStatusEdit(lead: LeadDto) {
    setEditing(lead);
    setNextStatus(LEAD_TRANSITIONS[lead.status][0] ?? "");
    setStatusError(null);
  }

  async function handleStatusSave() {
    if (!editing || !nextStatus) return;
    setSavingStatus(true);
    setStatusError(null);
    try {
      await updateLead(editing.id, { status: nextStatus, version: editing.version });
      setEditing(null);
      setReloadToken((token) => token + 1);
    } catch (err) {
      setStatusError(crmErrorMessage(err));
    } finally {
      setSavingStatus(false);
    }
  }

  const columns = useMemo<DataTableColumn<LeadDto>[]>(
    () => [
      {
        key: "name",
        header: "نام سرنخ",
        render: (row) => (
          <div>
            <span className="font-medium text-slate-800">{row.name}</span>
            {row.phone && (
              <span dir="ltr" className="block text-[11px] text-slate-400">
                {faDigits(row.phone)}
              </span>
            )}
          </div>
        ),
      },
      {
        key: "party",
        header: "مشتری مرتبط",
        render: (row) => row.party?.nameFa ?? <span className="text-slate-400">—</span>,
      },
      {
        key: "salesperson",
        header: "فروشنده",
        render: (row) => row.salesperson?.username ?? "—",
      },
      {
        key: "source",
        header: "منبع",
        render: (row) => row.source ?? <span className="text-slate-400">—</span>,
      },
      {
        key: "status",
        header: "وضعیت",
        align: "center",
        render: (row) => <LeadStatusBadge status={row.status} />,
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
        render: (row) =>
          LEAD_TRANSITIONS[row.status].length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => openStatusEdit(row)}>
              تغییر وضعیت
            </Button>
          ) : (
            <span className="text-xs text-slate-300">نهایی</span>
          ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">سرنخ‌ها</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            مدیریت سرنخ‌های فروش؛ زنجیره وضعیت: جدید ← تماس گرفته‌شده ← واجد شرایط / باخته
          </p>
        </div>
        <Button onClick={() => setFormOpen(true)} aria-label="ثبت سرنخ جدید">
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
          سرنخ جدید
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-64">
          <label htmlFor="lead-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (نام، تلفن)
          </label>
          <Input
            id="lead-search"
            inputSize="sm"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="جستجو…"
            aria-label="جستجوی سرنخ‌ها"
          />
        </div>
        <div className="w-40">
          <label htmlFor="lead-status" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="lead-status"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as LeadStatus | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-700 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
          >
            <option value="">همه</option>
            {LEAD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {LEAD_STATUS_LABELS[value]}
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

      <DataTable<LeadDto>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={loading}
        dense
        ariaLabel="فهرست سرنخ‌ها"
        pagination={
          data
            ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage }
            : null
        }
      />

      {/* Create lead */}
      <Modal
        open={formOpen}
        title="ثبت سرنخ جدید"
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
            <label htmlFor="lead-name" className="mb-1 block text-xs font-medium text-slate-600">
              نام سرنخ *
            </label>
            <Input
              id="lead-name"
              value={form.name}
              onChange={(event) => setForm((f) => ({ ...f, name: event.target.value }))}
              aria-label="نام سرنخ"
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="lead-phone" className="mb-1 block text-xs font-medium text-slate-600">
                تلفن
              </label>
              <Input
                id="lead-phone"
                dir="ltr"
                value={form.phone}
                onChange={(event) => setForm((f) => ({ ...f, phone: event.target.value }))}
                aria-label="تلفن سرنخ"
              />
            </div>
            <div>
              <label htmlFor="lead-source" className="mb-1 block text-xs font-medium text-slate-600">
                منبع
              </label>
              <Input
                id="lead-source"
                value={form.source}
                onChange={(event) => setForm((f) => ({ ...f, source: event.target.value }))}
                aria-label="منبع سرنخ"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">مشتری مرتبط (اختیاری)</label>
              <EntitySelector
                endpoint={(q) => `/parties?search=${encodeURIComponent(q)}&pageSize=10`}
                mapItem={partyMapItem}
                value={form.party}
                onChange={(party) => setForm((f) => ({ ...f, party }))}
                placeholder="جستجوی شخص…"
                ariaLabel="انتخاب مشتری مرتبط"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">فروشنده (اختیاری)</label>
              <EntitySelector
                endpoint={(q) => `/users?search=${encodeURIComponent(q)}`}
                mapItem={userMapItem}
                value={form.salesperson}
                onChange={(salesperson) => setForm((f) => ({ ...f, salesperson }))}
                placeholder="جستجوی کاربر…"
                ariaLabel="انتخاب فروشنده"
              />
            </div>
          </div>
          <div>
            <label htmlFor="lead-notes" className="mb-1 block text-xs font-medium text-slate-600">
              یادداشت
            </label>
            <textarea
              id="lead-notes"
              rows={2}
              value={form.notes}
              onChange={(event) => setForm((f) => ({ ...f, notes: event.target.value }))}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              aria-label="یادداشت سرنخ"
            />
          </div>
        </div>
      </Modal>

      {/* Status edit */}
      <Modal
        open={editing !== null}
        title={`تغییر وضعیت سرنخ: ${editing?.name ?? ""}`}
        onClose={() => setEditing(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>
              انصراف (Esc)
            </Button>
            <Button
              size="sm"
              onClick={() => void handleStatusSave()}
              disabled={savingStatus || !nextStatus}
            >
              ذخیره
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {statusError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {statusError}
            </div>
          )}
          <p className="text-xs text-slate-500">
            وضعیت فعلی: <LeadStatusBadge status={editing?.status ?? "NEW"} />
          </p>
          <div>
            <label htmlFor="lead-next-status" className="mb-1 block text-xs font-medium text-slate-600">
              وضعیت جدید
            </label>
            <select
              id="lead-next-status"
              value={nextStatus}
              onChange={(event) => setNextStatus(event.target.value as LeadStatus)}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            >
              <option value="">انتخاب کنید…</option>
              {(editing ? LEAD_TRANSITIONS[editing.status] : []).map((value) => (
                <option key={value} value={value}>
                  {LEAD_STATUS_LABELS[value]}
                </option>
              ))}
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}
