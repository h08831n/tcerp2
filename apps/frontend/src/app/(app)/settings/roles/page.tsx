"use client";

/**
 * IAM-001 §7-§10 — role management + the Permission Matrix
 * (settings → کاربران و امنیت → نقش‌ها). The matrix is fed by the REAL
 * permission catalog (GET /permissions grouped by module) and saved through
 * PUT /roles/:id/permissions (transactional, audited PERMISSIONS_CHANGED).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  createRole,
  fetchPermissionCatalog,
  fetchRole,
  fetchRoles,
  setRolePermissions,
  updateRole,
  type PermissionRow,
  type RoleRow,
} from "@/lib/admin";
import { faDigits, jalali } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";

export default function RolesAdminPage() {
  const { permissions } = useAuth();
  const canCreate = permissions.includes("roles.create");
  const canEdit = permissions.includes("roles.edit");

  const [data, setData] = useState<RoleRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // create/edit
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<RoleRow | null>(null);
  const [form, setForm] = useState({ code: "", nameFa: "", nameEn: "" });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // permission matrix
  const [matrixOpen, setMatrixOpen] = useState(false);
  const [matrixTarget, setMatrixTarget] = useState<RoleRow | null>(null);
  const [catalog, setCatalog] = useState<PermissionRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [permSearch, setPermSearch] = useState("");
  const [savingMatrix, setSavingMatrix] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchRoles({ pageSize: 100 }) // PaginationDto @Max(100)
      .then((res) => {
        if (!cancelled) {
          setData(res.items);
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

  const catalogByModule = useMemo(() => {
    const map = new Map<string, PermissionRow[]>();
    for (const p of catalog) {
      const list = map.get(p.module) ?? [];
      list.push(p);
      map.set(p.module, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [catalog]);

  const filteredCatalog = useMemo(() => {
    if (!permSearch.trim()) return catalogByModule;
    const q = permSearch.trim().toLowerCase();
    return catalogByModule
      .map(([module, perms]) => [
        module,
        perms.filter(
          (p) => p.code.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q),
        ),
      ] as [string, PermissionRow[]])
      .filter(([, perms]) => perms.length > 0);
  }, [catalogByModule, permSearch]);

  function openCreate() {
    setEditing(null);
    setForm({ code: "", nameFa: "", nameEn: "" });
    setFormError(null);
    setFormOpen(true);
  }

  async function openEdit(row: RoleRow) {
    const full = await fetchRole(row.id);
    setEditing(full);
    setForm({ code: full.code, nameFa: full.nameFa, nameEn: full.nameEn ?? "" });
    setFormError(null);
    setFormOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await updateRole(editing.id, { nameFa: form.nameFa.trim(), nameEn: form.nameEn.trim() || undefined });
      } else {
        await createRole({ code: form.code.trim(), nameFa: form.nameFa.trim(), nameEn: form.nameEn.trim() || undefined });
      }
      setFormOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "خطا در ذخیره نقش");
    } finally {
      setSaving(false);
    }
  }

  async function openMatrix(row: RoleRow) {
    setMatrixTarget(row);
    setMatrixError(null);
    setPermSearch("");
    if (catalog.length === 0) {
      setCatalog(await fetchPermissionCatalog().catch(() => []));
    }
    const full = await fetchRole(row.id);
    setSelected(new Set((full.permissions ?? []).map((p) => p.permission.id)));
    setMatrixOpen(true);
  }

  async function handleSaveMatrix() {
    if (!matrixTarget) return;
    setSavingMatrix(true);
    setMatrixError(null);
    try {
      await setRolePermissions(matrixTarget.id, Array.from(selected));
      setMatrixOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setMatrixError(err instanceof Error ? err.message : "خطا در ذخیره مجوزها");
    } finally {
      setSavingMatrix(false);
    }
  }

  const columns = useMemo<DataTableColumn<RoleRow>[]>(
    () => [
      { key: "nameFa", header: "عنوان نقش", render: (row) => <span className="font-medium text-slate-800">{row.nameFa}</span> },
      { key: "code", header: "کد", render: (row) => <span dir="ltr" className="text-xs text-slate-500">{row.code}</span> },
      {
        key: "isSystem",
        header: "نوع",
        align: "center",
        render: (row) =>
          row.isSystem ? (
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">سیستمی</span>
          ) : (
            <span className="rounded-full bg-sky-50 px-2 py-0.5 text-[11px] text-sky-700">سفارشی</span>
          ),
      },
      {
        key: "active",
        header: "وضعیت",
        align: "center",
        render: (row) => (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              row.active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            }`}
          >
            {row.active ? "فعال" : "غیرفعال"}
          </span>
        ),
      },
      {
        key: "permCount",
        header: "تعداد مجوزها",
        align: "center",
        render: (row) => faDigits(row.permissions?.length ?? 0),
      },
      {
        key: "createdAt",
        header: "تاریخ ایجاد",
        render: (row) => <span className="text-xs text-slate-500">{jalali(row.createdAt)}</span>,
      },
      {
        key: "actions",
        header: "",
        align: "end",
        render: (row) =>
          canEdit ? (
            <div className="flex justify-end gap-1">
              <Button size="sm" variant="ghost" onClick={() => void openMatrix(row)}>
                مجوزها
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openEdit(row)}>
                ویرایش
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
          <h2 className="text-lg font-bold text-slate-800">نقش‌ها</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            تعریف نقش‌های سازمانی و تعیین مجوزهای هر نقش از طریق ماتریس مجوزها.
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreate} aria-label="ایجاد نقش جدید">
            نقش جدید
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <DataTable<RoleRow>
        columns={columns}
        rows={data ?? []}
        rowKey={(row) => row.id}
        loading={loading}
        dense
        ariaLabel="فهرست نقش‌ها"
      />

      {/* Create / Edit */}
      <Modal
        open={formOpen}
        title={editing ? `ویرایش نقش: ${editing.nameFa}` : "ایجاد نقش جدید"}
        onClose={() => setFormOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setFormOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره"}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {formError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {formError}
            </div>
          )}
          <div>
            <label htmlFor="r-code" className="mb-1 block text-xs font-medium text-slate-600">
              کد یکتا {editing && <span className="text-[10px] text-slate-400">(غیرقابل تغییر)</span>}
            </label>
            <Input
              id="r-code"
              dir="ltr"
              value={form.code}
              disabled={!!editing}
              onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            />
          </div>
          <div>
            <label htmlFor="r-namefa" className="mb-1 block text-xs font-medium text-slate-600">عنوان نقش (فارسی)</label>
            <Input id="r-namefa" value={form.nameFa} onChange={(e) => setForm((f) => ({ ...f, nameFa: e.target.value }))} />
          </div>
          <div>
            <label htmlFor="r-nameen" className="mb-1 block text-xs font-medium text-slate-600">عنوان لاتین</label>
            <Input id="r-nameen" dir="ltr" value={form.nameEn} onChange={(e) => setForm((f) => ({ ...f, nameEn: e.target.value }))} />
          </div>
        </div>
      </Modal>

      {/* Permission Matrix */}
      <Modal
        open={matrixOpen}
        title={`ماتریس مجوزها: ${matrixTarget?.nameFa ?? ""}`}
        onClose={() => setMatrixOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setMatrixOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleSaveMatrix()} disabled={savingMatrix}>
              {savingMatrix ? "در حال ذخیره…" : `ذخیره (${faDigits(selected.size)} مجوز)`}
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {matrixError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {matrixError}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              value={permSearch}
              onChange={(e) => setPermSearch(e.target.value)}
              placeholder="جستجوی مجوز…"
              aria-label="جستجوی مجوز"
              inputSize="sm"
            />
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
              {faDigits(selected.size)} انتخاب‌شده
            </span>
          </div>
          <div className="max-h-80 space-y-3 overflow-y-auto rounded-md border border-slate-200 p-2">
            {filteredCatalog.map(([module, perms]) => {
              const allSelected = perms.every((p) => selected.has(p.id));
              return (
                <div key={module} className="rounded-md border border-slate-100">
                  <div className="flex items-center justify-between bg-slate-50 px-2 py-1">
                    <span className="text-xs font-bold text-slate-700" dir="ltr">
                      {module}
                    </span>
                    <button
                      type="button"
                      className="text-[11px] text-primary-700 hover:underline"
                      onClick={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (allSelected) perms.forEach((p: PermissionRow) => next.delete(p.id));
                          else perms.forEach((p: PermissionRow) => next.add(p.id));
                          return next;
                        })
                      }
                    >
                      {allSelected ? "لغو همهٔ این ماژول" : "انتخاب همهٔ این ماژول"}
                    </button>
                  </div>
                  <ul className="p-1">
                    {perms.map((p: PermissionRow) => (
                      <li key={p.id}>
                        <label className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-xs hover:bg-slate-50">
                          <input
                            type="checkbox"
                            className="mt-0.5"
                            checked={selected.has(p.id)}
                            onChange={(e) =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(p.id);
                                else next.delete(p.id);
                                return next;
                              })
                            }
                          />
                          <span>
                            <span dir="ltr" className="font-medium text-slate-700">
                              {p.code}
                            </span>
                            {p.description && <span className="block text-[10px] text-slate-400">{p.description}</span>}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-400">
            ذخیرهٔ ماتریس کل مجموعهٔ مجوزهای نقش را جایگزین می‌کند و در تاریخچهٔ امنیتی ثبت می‌شود.
          </p>
        </div>
      </Modal>
    </div>
  );
}
