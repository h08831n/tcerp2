"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { faDigits, jalaliDateTime } from "@/lib/format";
import { apiJson } from "@/lib/api";

interface ApprovalRow {
  id: string;
  companyId: string;
  entityType: string;
  entityId: string;
  approvalType: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  reason: string | null;
  createdAt: string;
}

const STATUS_LABELS: Record<ApprovalRow["status"], string> = {
  PENDING: "در انتظار",
  APPROVED: "تأییدشده",
  REJECTED: "ردشده",
  CANCELLED: "لغوشده",
};

const STATUS_BADGES: Record<ApprovalRow["status"], string> = {
  PENDING: "bg-amber-100 text-amber-800",
  APPROVED: "bg-emerald-100 text-emerald-800",
  REJECTED: "bg-rose-100 text-rose-800",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const TYPE_LABELS: Record<string, string> = {
  RELEASE_DRIVER_INFO: "افشای اطلاعات راننده",
};

function entityHref(row: ApprovalRow): string | null {
  if (row.entityType === "loading") return `/loadings/${row.entityId}`;
  return null;
}

export default function ApprovalsPage() {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 20;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiJson<{ items: ApprovalRow[]; total: number }>(
        `/approvals?page=${page}&pageSize=${pageSize}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setBusyId(id);
    setError(null);
    try {
      await apiJson(`/approvals/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns: DataTableColumn<ApprovalRow>[] = [
    {
      key: "type",
      header: "نوع",
      render: (r) => <span className="text-sm text-slate-800">{TYPE_LABELS[r.approvalType] ?? r.approvalType}</span>,
    },
    {
      key: "entity",
      header: "مرجع",
      render: (r) => {
        const href = entityHref(r);
        return href ? (
          <Link href={href} className="text-xs text-sky-700 hover:underline">
            باز کردن سند
          </Link>
        ) : (
          <span className="text-xs text-slate-400">{r.entityType}</span>
        );
      },
    },
    {
      key: "createdAt",
      header: "تاریخ درخواست",
      render: (r) => <span className="text-xs tabular-nums text-slate-700">{jalaliDateTime(r.createdAt)}</span>,
    },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (r) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGES[r.status]}`}>
          {STATUS_LABELS[r.status]}
        </span>
      ),
    },
    {
      key: "decide",
      header: "تصمیم",
      align: "center",
      render: (r) =>
        r.status === "PENDING" ? (
          <div className="flex justify-center gap-1">
            <Button variant="primary" disabled={busyId === r.id} onClick={() => void decide(r.id, "APPROVED")}>
              تأیید
            </Button>
            <Button variant="danger" disabled={busyId === r.id} onClick={() => void decide(r.id, "REJECTED")}>
              رد
            </Button>
          </div>
        ) : (
          <span className="text-xs text-slate-400">—</span>
        ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-bold text-slate-800">تأییدها</h1>
      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        loading={loading}
        emptyMessage="درخواست تأییدی وجود ندارد"
      />
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>
          مجموع {faDigits(total)} — صفحه {faDigits(page)} از {faDigits(totalPages)}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            قبلی
          </Button>
          <Button variant="ghost" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            بعدی
          </Button>
        </div>
      </div>
    </div>
  );
}
