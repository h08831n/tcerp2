"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { JalaliDateInput } from "@/components/ui/jalali-date-input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EntitySelector, type EntityOption } from "@/components/ui/entity-selector";
import { faDigits, faMoneyExact, jalali } from "@/lib/format";
import {
  TAX_INVOICE_STATUS_CLASSES,
  TAX_INVOICE_STATUS_LABELS,
  TAX_INVOICE_SUBJECT_LABELS,
  taxInvoiceErrorMessage,
  createTaxInvoiceFromSales,
  fetchTaxInvoice,
  fetchTaxInvoices,
  inquiryTaxInvoice,
  sendTaxInvoice,
  type SalesTaxInvoiceRow,
  type SalesTaxInvoiceStatus,
} from "@/lib/tax-invoices";

/** صورتحساب‌های مالیاتی (Phase 8) — create from completed sales, send to
 *  Moadian, track status/errors/submissions. */
export default function TaxInvoicesPage() {
  const [rows, setRows] = useState<SalesTaxInvoiceRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<"" | SalesTaxInvoiceStatus>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pageSize = 20;

  // create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<EntityOption | null>(null);
  const [subject, setSubject] = useState("MAIN");
  const [issueDate, setIssueDate] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // detail modal
  const [detailId, setDetailId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchTaxInvoices({
        status: statusFilter || undefined,
        page,
        pageSize,
      });
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(taxInvoiceErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    if (!selectedDoc) return;
    setError(null);
    setNotice(null);
    setCreating(true);
    try {
      const created = await createTaxInvoiceFromSales({
        salesDocumentId: selectedDoc.id,
        subject,
        issueDate: issueDate ?? undefined,
      });
      setCreateOpen(false);
      setSelectedDoc(null);
      setNotice(`صورتحساب ${created.number} ساخته شد (آماده ارسال).`);
      await load();
    } catch (e) {
      setError(taxInvoiceErrorMessage(e));
    } finally {
      setCreating(false);
    }
  };

  const send = async (id: string) => {
    setError(null);
    setNotice(null);
    setBusyId(id);
    try {
      const res = await sendTaxInvoice(id);
      setNotice(
        res.status === "SUBMITTED"
          ? `ارسال شد — شماره پیگیری مرجع: ${res.referenceNumber ?? "—"}`
          : `ارسال ناموفق بود: ${res.errorCode ?? ""}`,
      );
      await load();
    } catch (e) {
      setError(taxInvoiceErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const inquire = async (id: string) => {
    setError(null);
    setNotice(null);
    setBusyId(id);
    try {
      const res = await inquiryTaxInvoice(id);
      setNotice(
        res.status === "SUCCESS"
          ? "ثبت در مودیان تأیید شد."
          : res.status === "FAILED"
            ? "مودیان این صورتحساب را رد کرده است — جزئیات در تاریخچه."
            : "مودیان هنوز در حال بررسی است (PENDING).",
      );
      await load();
    } catch (e) {
      setError(taxInvoiceErrorMessage(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns: DataTableColumn<SalesTaxInvoiceRow>[] = [
    { key: "number", header: "شماره", render: (r) => faDigits(r.number) },
    {
      key: "status",
      header: "وضعیت",
      render: (r) => (
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${TAX_INVOICE_STATUS_CLASSES[r.status]}`}>
          {TAX_INVOICE_STATUS_LABELS[r.status]}
        </span>
      ),
    },
    { key: "customer", header: "مشتری", render: (r) => r.customer?.nameFa ?? "—" },
    { key: "issueDate", header: "تاریخ صدور", render: (r) => jalali(r.issueDate) },
    { key: "grandTotal", header: "جمع کل", render: (r) => faMoneyExact(r.grandTotal) },
    { key: "taxTotal", header: "مالیات", render: (r) => faMoneyExact(r.taxTotal) },
    {
      key: "moadian",
      header: "مودیان",
      render: (r) =>
        r.moadianStatus ? (
          <span title={r.moadianError ?? undefined}>{r.moadianStatus}</span>
        ) : (
          "—"
        ),
    },
    {
      key: "actions",
      header: "",
      render: (r) => (
        <div className="flex gap-1">
          {(r.status === "READY" || r.status === "FAILED") && (
            <Button variant="secondary" disabled={busyId === r.id} onClick={() => void send(r.id)}>
              {busyId === r.id ? "…" : "ارسال"}
            </Button>
          )}
          {r.status === "SUBMITTED" && (
            <Button variant="secondary" disabled={busyId === r.id} onClick={() => void inquire(r.id)}>
              {busyId === r.id ? "…" : "استعلام"}
            </Button>
          )}
          <Button variant="ghost" onClick={() => setDetailId(r.id)}>
            جزئیات
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <label className="mb-1 block text-xs text-slate-500">وضعیت</label>
          <select
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value as "" | SalesTaxInvoiceStatus);
            }}
            className="h-9 rounded-md border border-slate-300 bg-white px-2 text-sm"
          >
            <option value="">همه</option>
            {Object.entries(TAX_INVOICE_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>صورتحساب جدید از سند فروش</Button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="صورتحسابی ثبت نشده است."
        dense
      />

      {total > pageSize && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <Button variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            قبلی
          </Button>
          <span className="text-slate-500">
            صفحه {faDigits(page)} از {faDigits(Math.max(1, Math.ceil(total / pageSize)))}
          </span>
          <Button
            variant="secondary"
            disabled={page >= Math.ceil(total / pageSize)}
            onClick={() => setPage((p) => p + 1)}
          >
            بعدی
          </Button>
        </div>
      )}

      <Modal
        open={createOpen}
        title="صورتحساب مالیاتی از سند فروش"
        onClose={() => setCreateOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              انصراف
            </Button>
            <Button onClick={() => void create()} disabled={creating || !selectedDoc}>
              ایجاد صورتحساب
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <p className="text-xs leading-5 text-slate-500">
            صورتحساب از سند فروش <span className="font-medium">تکمیل‌شده</span> ساخته می‌شود؛ مقدار هر ردیف از
            بارگیری‌های انجام‌شده همان ردیف گرفته می‌شود و مالیات بر پایه نرخ ثبت‌شده در سند محاسبه می‌گردد.
          </p>
          <div>
            <span className="mb-1 block text-xs text-slate-500">سند فروش</span>
            <EntitySelector
              endpoint={(search) => `/sales?search=${encodeURIComponent(search)}&status=COMPLETED&pageSize=20`}
              mapItem={(raw) => {
                const r = raw as {
                  id: string;
                  documentNumber: string;
                  customer?: { nameFa?: string };
                  total?: string;
                };
                return {
                  id: r.id,
                  label: `${r.documentNumber} — ${r.customer?.nameFa ?? ""}`,
                };
              }}
              value={selectedDoc}
              onChange={setSelectedDoc}
              placeholder="انتخاب سند فروش تکمیل‌شده"
              ariaLabel="انتخاب سند فروش"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-slate-500">نوع</label>
            <select
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"
            >
              <option value="MAIN">اصلی</option>
              <option value="CORRECTIVE">اصلاحی</option>
              <option value="CANCEL">ابطالی</option>
              <option value="RETURN">برگشتی</option>
            </select>
          </div>
          <div>
            <span className="mb-1 block text-xs text-slate-500">تاریخ صدور</span>
            <JalaliDateInput value={issueDate} onChange={setIssueDate} />
          </div>
        </div>
      </Modal>

      <TaxInvoiceDetailModal
        detailId={detailId}
        onClose={() => setDetailId(null)}
        onChanged={load}
        setError={setError}
        setNotice={setNotice}
      />
    </div>
  );
}

function TaxInvoiceDetailModal({
  detailId,
  onClose,
  onChanged,
  setError,
  setNotice,
}: {
  detailId: string | null;
  onClose: () => void;
  onChanged: () => Promise<void>;
  setError: (s: string | null) => void;
  setNotice: (s: string | null) => void;
}) {
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchTaxInvoice>> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setErrorLocal] = useState<string | null>(null);

  const load = useCallback(async (id: string) => {
    setLoading(true);
    setErrorLocal(null);
    try {
      setDetail(await fetchTaxInvoice(id));
    } catch (e) {
      setErrorLocal(taxInvoiceErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (detailId) void load(detailId);
  }, [detailId, load]);

  const send = async (id: string) => {
    try {
      const res = await sendTaxInvoice(id);
      setNotice(res.status === "SUBMITTED" ? `ارسال شد — مرجع: ${res.referenceNumber ?? "—"}` : "ارسال ناموفق.");
      await onChanged();
      if (detailId) await load(detailId);
    } catch (e) {
      setError(taxInvoiceErrorMessage(e));
    }
  };

  const inquire = async (id: string) => {
    try {
      const res = await inquiryTaxInvoice(id);
      setNotice(res.status === "SUCCESS" ? "تأیید شد." : res.status === "FAILED" ? "رد شد." : "PENDING");
      await onChanged();
      if (detailId) await load(detailId);
    } catch (e) {
      setError(taxInvoiceErrorMessage(e));
    }
  };

  return (
    <Modal open={!!detailId} title="جزئیات صورتحساب مالیاتی" onClose={onClose}>
      {loading && <div className="p-4 text-sm text-slate-500">در حال بارگذاری…</div>}
      {!loading && error && <div className="p-4 text-sm text-rose-600">{error}</div>}
      {!loading && detail && (
        <div className="space-y-4 text-sm">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <span className="text-slate-500">شماره: </span>
              <span className="font-medium">{faDigits(detail.number)}</span>
            </div>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${TAX_INVOICE_STATUS_CLASSES[detail.status]}`}>
              {TAX_INVOICE_STATUS_LABELS[detail.status]}
            </span>
            <div>
              <span className="text-slate-500">موضوع: </span>
              <span>{TAX_INVOICE_SUBJECT_LABELS[detail.subject] ?? detail.subject}</span>
            </div>
            <div>
              <span className="text-slate-500">مشتری: </span>
              <span>{detail.customer.nameFa}</span>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="min-w-full divide-y divide-slate-200 text-right">
              <thead className="bg-slate-50 text-xs text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">شرح</th>
                  <th className="px-3 py-2 font-medium">مقدار</th>
                  <th className="px-3 py-2 font-medium">فی</th>
                  <th className="px-3 py-2 font-medium">پس‌کرک</th>
                  <th className="px-3 py-2 font-medium">نرخ مالیات</th>
                  <th className="px-3 py-2 font-medium">مالیات</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {detail.lines.map((l) => (
                  <tr key={l.id}>
                    <td className="px-3 py-2">{l.description}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {faMoneyExact(l.quantity)}
                      {l.mu ? ` ${faDigits(l.mu)}` : ""}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{faMoneyExact(l.unitPrice)}</td>
                    <td className="px-3 py-2 tabular-nums">{faMoneyExact(l.prdis)}</td>
                    <td className="px-3 py-2 tabular-nums">{faDigits(l.vra)}٪</td>
                    <td className="px-3 py-2 tabular-nums">{faMoneyExact(l.vam)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded border border-slate-200 p-2">
              جمع پس‌کرک: {faMoneyExact(detail.subtotal)}
            </div>
            <div className="rounded border border-slate-200 p-2">مالیات کل: {faMoneyExact(detail.taxTotal)}</div>
            <div className="rounded border border-teal-200 bg-teal-50 p-2">
              جمع کل: {faMoneyExact(detail.grandTotal)}
            </div>
          </div>

          {detail.moadianError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
              خطای مودیان: {detail.moadianError}
            </div>
          )}
          {detail.confirmationReferenceId && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
              شماره تأیید مودیان: {detail.confirmationReferenceId}
            </div>
          )}

          <div>
            <h4 className="mb-2 text-xs font-semibold text-slate-700">تاریخچه ارسال</h4>
            {detail.submissions.length === 0 ? (
              <div className="text-xs text-slate-500">هنوز ارسالی ثبت نشده است.</div>
            ) : (
              <table className="min-w-full text-right text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-2 py-1 font-medium">تلاش</th>
                    <th className="px-2 py-1 font-medium">وضعیت</th>
                    <th className="px-2 py-1 font-medium">مرجع</th>
                    <th className="px-2 py-1 font-medium">خطا</th>
                    <th className="px-2 py-1 font-medium">زمان</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {detail.submissions.map((s) => (
                    <tr key={s.id}>
                      <td className="px-2 py-1">{faDigits(s.attempt)}{s.retry ? " (تلاش مجدد)" : ""}</td>
                      <td className="px-2 py-1">{s.status}</td>
                      <td className="px-2 py-1">{s.referenceNumber ?? "—"}</td>
                      <td className="px-2 py-1 text-rose-700">{s.errorDetail ?? "—"}</td>
                      <td className="px-2 py-1">{jalali(s.sentAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {(detail.status === "READY" || detail.status === "FAILED" || detail.status === "SUBMITTED") && (
            <div className="flex justify-end gap-2">
              {(detail.status === "READY" || detail.status === "FAILED") && (
                <Button variant="secondary" onClick={() => void send(detail.id)}>
                  {detail.status === "FAILED" ? "تلاش مجدد ارسال" : "ارسال به مودیان"}
                </Button>
              )}
              {detail.status === "SUBMITTED" && (
                <Button variant="secondary" onClick={() => void inquire(detail.id)}>
                  استعلام وضعیت
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
