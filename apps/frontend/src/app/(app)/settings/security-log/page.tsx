"use client";

/**
 * IAM-001 §16 — security audit trail (settings → کاربران و امنیت → تاریخچه امنیتی).
 * Backed by GET /audit (audit.view permission, backend-enforced).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  SECURITY_ACTIONS,
  fetchSecurityAudit,
  type SecurityAuditRow,
} from "@/lib/admin";
import { jalaliDateTime } from "@/lib/format";

const PAGE_SIZE = 50;

const ACTION_LABELS: Record<string, string> = {
  CREATE: "ایجاد",
  UPDATE: "ویرایش",
  DELETE: "حذف",
  PASSWORD_RESET: "بازنشانی رمز",
  ROLE_ASSIGNED: "تخصیص نقش",
  ROLE_REMOVED: "حذف نقش",
  ROLES_CHANGED: "تغییر نقش‌ها",
  PERMISSIONS_CHANGED: "تغییر مجوزهای نقش",
  OVERRIDE: "override",
  LOGIN: "ورود",
  LOGIN_FAILED: "ورود ناموفق",
  LOGOUT: "خروج",
  ROLE_ADDED: "افزودن نقش",
  SALE_CONFIRMED: "قطعی‌شدن سفارش",
  LEAD_CREATED: "ثبت سرنخ",
};

export default function SecurityLogPage() {
  const [rows, setRows] = useState<SecurityAuditRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [actionFilter, setActionFilter] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetchSecurityAudit({ page, pageSize: PAGE_SIZE })
      .then((res) => {
        if (!cancelled) {
          setRows(res.items);
          setTotal(res.total);
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
  }, [page]);

  useEffect(() => load(), [load, reloadToken]);

  const filtered = useMemo(() => {
    const list = rows ?? [];
    if (!actionFilter) return list;
    return list.filter((r) => r.action === actionFilter);
  }, [rows, actionFilter]);

  const columns = useMemo<DataTableColumn<SecurityAuditRow>[]>(
    () => [
      {
        key: "createdAt",
        header: "زمان",
        render: (row) => <span className="text-xs text-slate-500">{jalaliDateTime(row.createdAt)}</span>,
      },
      {
        key: "actor",
        header: "انجام‌دهنده",
        render: (row) => row.actorName ?? "—",
      },
      {
        key: "action",
        header: "عملیات",
        render: (row) => (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-700">
            {ACTION_LABELS[row.action] ?? row.action}
          </span>
        ),
      },
      {
        key: "entity",
        header: "موضوع",
        render: (row) => (
          <span className="text-xs text-slate-600" dir="ltr">
            {row.entityType}
            {row.entityId ? ` · ${row.entityId.slice(0, 8)}…` : ""}
          </span>
        ),
      },
      {
        key: "details",
        header: "جزئیات",
        render: (row) => {
          const nv = row.newValues;
          if (!nv) return "—";
          const parts = Object.entries(nv)
            .filter(([k]) => k !== "password" && k !== "passwordHash")
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v).slice(0, 40)}`);
          return <span className="text-[11px] text-slate-500" dir="ltr">{parts.join(" · ") || "—"}</span>;
        },
      },
      {
        key: "ip",
        header: "IP",
        render: (row) => <span className="text-[11px] text-slate-400" dir="ltr">{row.ip ?? "—"}</span>,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold text-slate-800">تاریخچه امنیتی</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          تغییرات کاربران، نقش‌ها، مجوزها و رویدادهای ورود — ثبت Backend، غیرقابل تغییر توسط کاربران.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-56">
          <label htmlFor="sec-action" className="mb-1 block text-xs font-medium text-slate-600">
            نوع عملیات
          </label>
          <select
            id="sec-action"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs"
          >
            <option value="">همه</option>
            {SECURITY_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {ACTION_LABELS[a] ?? a}
              </option>
            ))}
          </select>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setReloadToken((t) => t + 1)}>
          بازخوانی
        </Button>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <DataTable<SecurityAuditRow>
        columns={columns}
        rows={filtered}
        rowKey={(row) => row.id}
        loading={loading}
        dense
        ariaLabel="تاریخچه امنیتی"
        pagination={
          actionFilter
            ? null
            : { page, pageSize: PAGE_SIZE, total, onPageChange: setPage }
        }
      />
    </div>
  );
}
