"use client";

/**
 * IAM-001 §3-§6 — user management (settings → کاربران و امنیت → مدیریت کاربران).
 * List + create + edit + roles assignment + enable/disable with confirm.
 * Backend stays the enforcement point (users.* permissions + last-admin law).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  USER_STATUS_LABELS,
  createUser,
  fetchRoles,
  fetchUser,
  fetchUsersAdmin,
  setUserCompanyRoles,
  updateUser,
  type UserRow,
  type UserStatus,
} from "@/lib/admin";
import { apiJson } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { userDisplayName } from "@/lib/crm";
import { faDigits, jalali } from "@/lib/format";

const PAGE_SIZE = 20;

export default function UsersAdminPage() {
  const { user: me, permissions } = useAuth();
  const canCreate = permissions.includes("users.create");
  const canEdit = permissions.includes("users.edit");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<UserStatus | "">("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: UserRow[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // create / edit modal
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<UserRow | null>(null);
  const [form, setForm] = useState({
    username: "",
    password: "",
    firstName: "",
    lastName: "",
    email: "",
    mobile: "",
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // roles assignment
  const [roles, setRoles] = useState<{ id: string; code: string; nameFa: string }[]>([]);
  const [userCompanyId, setUserCompanyId] = useState("");
  const [assignedRoleIds, setAssignedRoleIds] = useState<string[]>([]);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [rolesTarget, setRolesTarget] = useState<UserRow | null>(null);
  const [rolesError, setRolesError] = useState<string | null>(null);

  // disable confirm
  const [disabling, setDisabling] = useState<UserRow | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, 400);
    return () => clearTimeout(t);
  }, [searchInput]);

  const query = useMemo(
    () => ({ page, pageSize: PAGE_SIZE, search: search || undefined, status: status || undefined }),
    [page, search, status],
  );

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchUsersAdmin(query)
      .then((res) => {
        if (!cancelled) {
          setData(res);
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
  }, [query]);

  useEffect(() => load(), [load, reloadToken]);

  useEffect(() => {
    fetchRoles({ pageSize: 100 })
      .then((res) => setRoles(res.items.map((r) => ({ id: r.id, code: r.code, nameFa: r.nameFa }))))
      .catch(() => undefined);
  }, []);

  function openCreate() {
    setEditing(null);
    setForm({ username: "", password: "", firstName: "", lastName: "", email: "", mobile: "" });
    setFormError(null);
    setFormOpen(true);
  }

  async function openEdit(row: UserRow) {
    const full = await apiJson<UserRow & { companyRoles?: { companyId: string }[] }>(`/users/${row.id}`);
    setEditing(full);
    setForm({
      username: full.username,
      password: "",
      firstName: full.firstName ?? "",
      lastName: full.lastName ?? "",
      email: full.email ?? "",
      mobile: full.mobile ?? "",
    });
    setFormError(null);
    setFormOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    try {
      if (editing) {
        await updateUser(editing.id, {
          firstName: form.firstName.trim() || undefined,
          lastName: form.lastName.trim() || undefined,
          email: form.email.trim() || undefined,
          mobile: form.mobile.trim() || undefined,
          version: editing.version,
        });
        if (form.password.trim()) {
          await apiJson(`/users/${editing.id}/password`, {
            method: "POST",
            body: JSON.stringify({ password: form.password.trim() }),
          });
        }
      } else {
        await createUser({
          username: form.username.trim(),
          password: form.password,
          firstName: form.firstName.trim() || undefined,
          lastName: form.lastName.trim() || undefined,
          email: form.email.trim() || undefined,
          mobile: form.mobile.trim() || undefined,
        });
      }
      setFormOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "خطا در ذخیره");
    } finally {
      setSaving(false);
    }
  }

  async function openRoles(row: UserRow) {
    setRolesTarget(row);
    setRolesError(null);
    try {
      const full = await apiJson<UserRow>(`/users/${row.id}`);
      // Fresh users have no company yet — fall back to the ACTOR's default
      // company (the admin assigns the user into their own organization;
      // the backend auto-creates the membership + default company).
      const companyId =
        full.defaultCompanyId ??
        full.companies?.[0]?.id ??
        full.companyRoles?.[0]?.companyId ??
        (me?.defaultCompanyId as string | undefined) ??
        "";
      setUserCompanyId(companyId);
      const detail = await apiJson<UserRow>(`/users/${row.id}`);
      const codeToId = new Map(roles.map((r) => [r.code, r.id]));
      setAssignedRoleIds(
        (detail.companyRoles ?? [])
          .filter((cr) => cr.companyId === companyId)
          .map((cr) => cr.role.id),
      );
      setRolesOpen(true);
    } catch (err) {
      setRolesError(err instanceof Error ? err.message : "خطا");
    }
  }

  async function handleSaveRoles() {
    if (!rolesTarget || !userCompanyId) return;
    setBusy(true);
    setRolesError(null);
    try {
      await setUserCompanyRoles(rolesTarget.id, userCompanyId, assignedRoleIds);
      setRolesOpen(false);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setRolesError(err instanceof Error ? err.message : "خطا در تخصیص نقش‌ها");
    } finally {
      setBusy(false);
    }
  }

  async function handleDisable(row: UserRow) {
    setBusy(true);
    setError(null);
    try {
      const full = await apiJson<UserRow>(`/users/${row.id}`);
      await updateUser(row.id, { status: "DISABLED", version: full.version });
      setDisabling(null);
      setReloadToken((t) => t + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "خطا در غیرفعال‌سازی");
      setDisabling(null);
    } finally {
      setBusy(false);
    }
  }

  const columns = useMemo<DataTableColumn<UserRow>[]>(
    () => [
      {
        key: "name",
        header: "نام",
        render: (row) => userDisplayName(row),
      },
      { key: "username", header: "نام کاربری", render: (row) => <span dir="ltr">{row.username}</span> },
      { key: "email", header: "ایمیل", render: (row) => <span dir="ltr">{row.email ?? "—"}</span> },
      { key: "mobile", header: "موبایل", render: (row) => <span dir="ltr">{row.mobile ? faDigits(row.mobile) : "—"}</span> },
      {
        key: "status",
        header: "وضعیت",
        align: "center",
        render: (row) => (
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] ${
              row.status === "ACTIVE"
                ? "bg-emerald-50 text-emerald-700"
                : row.status === "DISABLED"
                  ? "bg-rose-50 text-rose-700"
                  : "bg-amber-50 text-amber-700"
            }`}
          >
            {USER_STATUS_LABELS[row.status]}
          </span>
        ),
      },
      {
        key: "lastLogin",
        header: "آخرین ورود",
        render: (row) => <span className="text-xs text-slate-500">{row.lastLoginAt ? jalali(row.lastLoginAt) : "—"}</span>,
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
              <Button size="sm" variant="ghost" onClick={() => void openRoles(row)}>
                نقش‌ها
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void openEdit(row)}>
                ویرایش
              </Button>
              {row.status === "ACTIVE" && row.id !== me?.id && (
                <Button size="sm" variant="ghost" onClick={() => setDisabling(row)}>
                  غیرفعال
                </Button>
              )}
            </div>
          ) : null,
      },
    ],
    [canEdit, me?.id],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">مدیریت کاربران</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            ایجاد و ویرایش کاربران، تخصیص نقش‌ها و فعال/غیرفعال‌سازی — تغییرات در تاریخچهٔ امنیتی ثبت می‌شود.
          </p>
        </div>
        {canCreate && (
          <Button onClick={openCreate} aria-label="ایجاد کاربر جدید">
            کاربر جدید
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-64">
          <label htmlFor="u-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (نام کاربری، ایمیل)
          </label>
          <Input id="u-search" inputSize="sm" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="جستجو…" />
        </div>
        <div className="w-40">
          <label htmlFor="u-status" className="mb-1 block text-xs font-medium text-slate-600">
            وضعیت
          </label>
          <select
            id="u-status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as UserStatus | "");
              setPage(1);
            }}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
          >
            <option value="">همه</option>
            {(Object.keys(USER_STATUS_LABELS) as UserStatus[]).map((s) => (
              <option key={s} value={s}>
                {USER_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <DataTable<UserRow>
        columns={columns}
        rows={data?.items ?? []}
        rowKey={(row) => row.id}
        loading={loading}
        dense
        ariaLabel="فهرست کاربران"
        pagination={data ? { page: data.page, pageSize: data.pageSize, total: data.total, onPageChange: setPage } : null}
      />

      {/* Create / Edit */}
      <Modal
        open={formOpen}
        title={editing ? `ویرایش کاربر: ${editing.username}` : "ایجاد کاربر جدید"}
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="u-first" className="mb-1 block text-xs font-medium text-slate-600">نام</label>
              <Input id="u-first" value={form.firstName} onChange={(e) => setForm((f) => ({ ...f, firstName: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="u-last" className="mb-1 block text-xs font-medium text-slate-600">نام خانوادگی</label>
              <Input id="u-last" value={form.lastName} onChange={(e) => setForm((f) => ({ ...f, lastName: e.target.value }))} />
            </div>
          </div>
          <div>
            <label htmlFor="u-username" className="mb-1 block text-xs font-medium text-slate-600">
              نام کاربری {editing && <span className="text-[10px] text-slate-400">(غیرقابل تغییر)</span>}
            </label>
            <Input
              id="u-username"
              dir="ltr"
              value={form.username}
              disabled={!!editing}
              onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="u-email" className="mb-1 block text-xs font-medium text-slate-600">ایمیل</label>
              <Input id="u-email" dir="ltr" value={form.email} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} />
            </div>
            <div>
              <label htmlFor="u-mobile" className="mb-1 block text-xs font-medium text-slate-600">موبایل</label>
              <Input id="u-mobile" dir="ltr" value={form.mobile} onChange={(e) => setForm((f) => ({ ...f, mobile: e.target.value }))} />
            </div>
          </div>
          <div>
            <label htmlFor="u-password" className="mb-1 block text-xs font-medium text-slate-600">
              {editing ? "رمز عبور جدید (خالی = بدون تغییر)" : "رمز عبور *"}
            </label>
            <Input
              id="u-password"
              type="password"
              dir="ltr"
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
            />
          </div>
        </div>
      </Modal>

      {/* Roles assignment */}
      <Modal
        open={rolesOpen}
        title={`نقش‌های کاربر: ${rolesTarget?.username ?? ""}`}
        onClose={() => setRolesOpen(false)}
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setRolesOpen(false)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" onClick={() => void handleSaveRoles()} disabled={busy}>
              ذخیره نقش‌ها
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          {rolesError && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {rolesError}
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            نقش‌ها برای شرکت پیش‌فرض کاربر اعمال می‌شوند. تخصیص نقش مدیر سیستم فقط برای مدیرهای موجود مجاز است.
          </p>
          {roles.map((r) => (
            <label key={r.id} className="flex items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={assignedRoleIds.includes(r.id)}
                onChange={(e) =>
                  setAssignedRoleIds((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((i) => i !== r.id)))
                }
              />
              <span>{r.nameFa}</span>
              <span className="text-[10px] text-slate-400" dir="ltr">
                {r.code}
              </span>
            </label>
          ))}
        </div>
      </Modal>

      {/* Disable confirm */}
      <Modal
        open={disabling !== null}
        title={`غیرفعال‌سازی کاربر: ${disabling?.username ?? ""}`}
        onClose={() => setDisabling(null)}
        small
        footer={
          <>
            <Button variant="secondary" size="sm" onClick={() => setDisabling(null)}>
              انصراف (Esc)
            </Button>
            <Button size="sm" variant="danger" onClick={() => disabling && void handleDisable(disabling)} disabled={busy}>
              غیرفعال کن
            </Button>
          </>
        }
      >
        <p className="text-xs leading-5 text-slate-600">
          کاربر غیرفعال بلافاصله از سیستم خارج می‌شود و امکان ورود مجدد ندارد. سوابق تاریخی او حفظ می‌شود.
          اگر این کاربر آخرین مدیر فعال سیستم باشد، عملیات در Backend رد می‌شود.
        </p>
      </Modal>
    </div>
  );
}
