"use client";

/**
 * CORE-003 — مرجع دلایل باخت پیش‌فاکتور (CRUD over /lost-reasons).
 * Real backend: POST/PATCH/DELETE /lost-reasons (crm.manage).
 * The sales `lost` endpoint REQUIRES one of these reasons when marking a
 * quotation LOST — this reference data is a hard dependency of that flow.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { apiJson } from "@/lib/api";
import { faDigits } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";

interface LostReasonRow {
  id: string;
  code: string;
  nameFa: string;
  nameEn: string | null;
  sortOrder: number;
  active: boolean;
  createdAt: string;
}

export default function LostReasonsPage() {
  const { permissions } = useAuth();
  const canEdit = permissions.includes("crm.manage");

  const [rows, setRows] = useState<LostReasonRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<LostReasonRow | null>(null);
  const [form, setForm] = useState({ code: "", nameFa: "", nameEn: "", sortOrder: 0 });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiJson<Paginated<LostReasonRow>>("/lost-reasons?page=1&pageSize=100")
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
      // Body rules: CREATE requires `code` (CreateLostReasonDto); PATCH must
      // NOT include it (UpdateLostReasonDto has no code field and
      // forbidNonWhitelisted rejects unknown fields — found by E2E).
      const body: Record<string, unknown> = editing
        ? {
            nameFa: form.nameFa.trim(),
            nameEn: form.nameEn.trim() || undefined,
            sortOrder: Number(form.sortOrder) || 0,
          }
        : {
            code: form.code.trim(),
            nameFa: form.nameFa.trim(),
            nameEn: form.nameEn.trim() || undefined,
            sortOrder: Number(form.sortOrder) || 0,
          };
      if (editing) {
        await apiJson(`/lost-reasons/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await apiJson("/lost-reasons", { method: "POST", body: JSON.stringify(body) });
      }
      setFormOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "خطا در ذخیره");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(row: LostReasonRow) {
    setError(null);
    try {
      await apiJson(`/lost-reasons/${row.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: !row.active }),
      });
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطا در تغییر وضعیت");
    }
  }

  const columns = useMemo<DataTableColumn<LostReasonRow>[]>(
    () => [
      { key: "nameFa", header: "عنوان", render: (row) => <span className="font-medium text-slate-800">{row.nameFa}</span> },
      { key: "code", header: "کد", render: (row) => <span dir="ltr" className="text-xs text-slate-500">{row.code}</span> },
      { key: "sortOrder", header: "ترتیب", align: "center", render: (row) => faDigits(row.sortOrder) },
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
              <Button size="sm" variant="ghost" onClick={() => { setEditing(row); setForm({ code: row.code, nameFa: row.nameFa, nameEn: row.nameEn ?? "", sortOrder: row.sortOrder }); setFormOpen(true); }}>
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
          <h2 className="text-lg font-bold text-slate-800">دلایل باخت پیش‌فاکتور</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            مرجع فهرست دلایل باخت — هنگام «باختن پیش‌فاکتور» انتخاب دلیل از همین فهرست الزامی است.
          </p>
        </div>
        {canEdit && (
          <Button onClick={() => { setEditing(null); setForm({ code: "", nameFa: "", nameEn: "", sortOrder: 0 }); setFormOpen(true); }}>
            دلیل جدید
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{error}</div>
      )}

      <DataTable<LostReasonRow>
        columns={columns}
        rows={rows ?? []}
        rowKey={(row) => row.id}
        loading={rows === null}
        dense
        ariaLabel="فهرست دلایل باخت"
      />

      <Modal
        open={formOpen}
        title={editing ? "ویرایش دلیل باخت" : "دلیل باخت جدید"}
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
            <label htmlFor="lr-code" className="mb-1 block text-xs font-medium text-slate-600">
              کد {editing && <span className="text-[10px] text-slate-400">(غیرقابل تغییر)</span>}
            </label>
            <Input id="lr-code" dir="ltr" value={form.code} disabled={!!editing} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="lr-namefa" className="mb-1 block text-xs font-medium text-slate-600">عنوان فارسی</label>
            <Input id="lr-namefa" value={form.nameFa} onChange={(e) => setForm((f) => ({ ...f, nameFa: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="lr-nameen" className="mb-1 block text-xs font-medium text-slate-600">عنوان لاتین (اختیاری)</label>
            <Input id="lr-nameen" dir="ltr" value={form.nameEn} onChange={(e) => setForm((f) => ({ ...f, nameEn: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="lr-order" className="mb-1 block text-xs font-medium text-slate-600">ترتیب نمایش</label>
            <Input id="lr-order" dir="ltr" inputMode="numeric" value={form.sortOrder} onChange={(e) => setForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))} />
          </div>
        </div>
      </Modal>

    </div>
  );
}

interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }
