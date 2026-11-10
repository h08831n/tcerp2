"use client";

/**
 * CORE-003 — مرجع شرایط پرداخت (CRUD over /payment-terms).
 * Real backend: POST/PATCH/DELETE /payment-terms (paymentterm.manage).
 * Consumed by sales documents (paymentTermId on every quotation/order).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { apiJson } from "@/lib/api";
import { faDigits } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";

interface PaymentTermRow {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  description: string | null;
  daysOffset: number | null;
  active: boolean;
  createdAt: string;
}

export default function PaymentTermsPage() {
  const { permissions } = useAuth();
  const canEdit = permissions.includes("paymentterm.manage");

  const [rows, setRows] = useState<PaymentTermRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentTermRow | null>(null);
  const [form, setForm] = useState({ code: "", nameFa: "", nameEn: "", description: "", daysOffset: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<Paginated<PaymentTermRow>>("/payment-terms?page=1&pageSize=100")
      .then((res) => {
        if (!cancelled) {
          setRows(res.items);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "خطا");
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => load(), [load, reloadToken]);

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      const body = {
        code: form.code.trim(),
        nameFa: form.nameFa.trim(),
        nameEn: form.nameEn.trim() || undefined,
        description: form.description.trim() || undefined,
        daysOffset: form.daysOffset.trim() === "" ? null : Number(form.daysOffset),
      };
      if (editing) {
        await apiJson(`/payment-terms/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await apiJson("/payment-terms", { method: "POST", body: JSON.stringify(body) });
      }
      setFormOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "خطا در ذخیره");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(row: PaymentTermRow) {
    setError(null);
    try {
      await apiJson(`/payment-terms/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !row.active }),
      });
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطا در تغییر وضعیت");
    }
  }

  const columns = useMemo<DataTableColumn<PaymentTermRow>[]>(
    () => [
      { key: "nameFa", header: "عنوان", render: (row) => <span className="font-medium text-slate-800">{row.nameFa}</span> },
      { key: "code", header: "کد", render: (row) => <span dir="ltr" className="text-xs text-slate-500">{row.code}</span> },
      {
        key: "daysOffset",
        header: "روزهای تسویه",
        align: "center",
        render: (row) => (row.daysOffset === null ? "—" : faDigits(row.daysOffset)),
      },
      { key: "description", header: "توضیحات", render: (row) => row.description ?? "—" },
      {
        key: "active",
        header: "وضعیت",
        align: "center",
        render: (row) => (
          <span className={`rounded-full px-2 py-0.5 text-[11px] ${row.active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"}`}>
            {row.active ? "فعال" : "غیرفعال"}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        align: "end",
        render: (row) =>
          canEdit ? (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => { setEditing(row); setForm({ code: row.code, nameFa: row.nameFa, nameEn: row.nameEn ?? "", description: row.description ?? "", daysOffset: row.daysOffset === null ? "" : String(row.daysOffset) }); setFormOpen(true); }}>
                ویرایش
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void handleToggle(row)}>
                {row.active ? "غیرفعال" : "فعال"}
              </Button>
            </div>
          ) : null,
      },
    ],
    [canEdit],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">شرایط پرداخت</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            مرجع شرایط پرداخت — در پیش‌فاکتورها و سفارش‌های فروش قابل انتخاب است.
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => { setEditing(null); setForm({ code: "", nameFa: "", nameEn: "", description: "", daysOffset: "" }); setFormOpen(true); }}>
            شرایط جدید
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      <DataTable<PaymentTermRow>
        columns={columns}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        loading={rows === null}
        dense
        ariaLabel="فهرست شرایط پرداخت"
      />

      <Modal
        open={formOpen}
        title={editing ? "ویرایش شرایط پرداخت" : "شرایط پرداخت جدید"}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen(false)}>انصراف (Esc)</Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>{saving ? "…" : "ذخیره"}</Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</div>
          )}
          <div>
            <label htmlFor="pt-code" className="mb-1 block text-xs font-medium text-slate-600">
              کد {editing && <span className="text-[10px] text-slate-400">(غیرقابل تغییر)</span>}
            </label>
            <Input id="pt-code" dir="ltr" value={form.code} disabled={!!editing} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pt-namefa" className="mb-1 block text-xs font-medium text-slate-600">عنوان فارسی</label>
            <Input id="pt-namefa" value={form.nameFa} onChange={(e) => setForm((f) => ({ ...f, nameFa: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pt-nameen" className="mb-1 block text-xs font-medium text-slate-600">عنوان لاتین (اختیاری)</label>
            <Input id="pt-nameen" dir="ltr" value={form.nameEn} onChange={(e) => setForm((f) => ({ ...f, nameEn: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pt-days" className="mb-1 block text-xs font-medium text-slate-600">روزهای تسویه (اختیاری)</label>
            <Input id="pt-days" dir="ltr" inputMode="numeric" value={form.daysOffset} onChange={(e) => setForm((f) => ({ ...f, daysOffset: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="pt-desc" className="mb-1 block text-xs font-medium text-slate-600">توضیحات</label>
            <Input id="pt-desc" value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
          </div>
        </div>
      </Modal>

    </div>
  );
}

interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }
