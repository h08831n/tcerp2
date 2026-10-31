"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalaliDateTime } from "@/lib/format";
import {
  cancelImport,
  createImportJob,
  fetchImportJobs,
  fetchImportRows,
  runImport,
  type ImportJobDto,
  type ImportRowDto,
} from "@/lib/imports";

const STATUS_LABELS: Record<ImportJobDto["status"], string> = {
  VALIDATED: "اعتبارسنجی‌شده",
  RUNNING: "در حال اجرا",
  COMPLETED: "تکمیل‌شده",
  PARTIALLY_FAILED: "ناقص",
  FAILED: "شکست",
  CANCELLED: "لغوشده",
};

const STATUS_BADGES: Record<ImportJobDto["status"], string> = {
  VALIDATED: "bg-sky-100 text-sky-800",
  RUNNING: "bg-amber-100 text-amber-800",
  COMPLETED: "bg-emerald-100 text-emerald-800",
  PARTIALLY_FAILED: "bg-orange-100 text-orange-800",
  FAILED: "bg-rose-100 text-rose-800",
  CANCELLED: "bg-slate-100 text-slate-600",
};

const ROW_STATUS_LABELS: Record<ImportRowDto["status"], string> = {
  PENDING: "در صف",
  OK: "ثبت‌شده",
  FAILED: "خطا",
  DUPLICATE: "تکراری",
};

/** CSV fields the PARTY importer understands (server whitelist order). */
const PARTY_FIELDS = ["nameFa", "nameEn", "type", "nationalId", "economicCode", "phone", "phone2"] as const;

export default function ImportsPage() {
  const [jobs, setJobs] = useState<ImportJobDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pageSize = 15;

  // create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [updateMatched, setUpdateMatched] = useState(false);
  const [commitMode, setCommitMode] = useState<"PER_ROW" | "BATCH">("PER_ROW");
  const [creating, setCreating] = useState(false);

  // rows modal
  const [rowsTarget, setRowsTarget] = useState<ImportJobDto | null>(null);
  const [rows, setRows] = useState<ImportRowDto[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchImportJobs({ page, pageSize });
      setJobs(res.items);
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

  // client-side file read → CSV text + auto-detected headers
  const onFile = async (file: File) => {
    const text = await file.text();
    setCsv(text);
    setFileName(file.name);
    const firstLine = text.split(/\r?\n/)[0] ?? "";
    setHeaders(firstLine.split(",").map((h) => h.replace(/^\uFEFF/, "").trim()));
    // auto-map known headers (exact match with field names)
    const auto: Record<string, string> = {};
    for (const field of PARTY_FIELDS) {
      if (headers.includes(field)) auto[field] = field;
    }
    setMapping(auto);
  };

  const submit = async () => {
    if (!csv.trim() || !mapping.nameFa) return;
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const job = await createImportJob({
        entityType: "PARTY",
        fileName: fileName || "import.csv",
        csv,
        columnMapping: mapping,
        updateMatched,
        commitMode,
      });
      setCreateOpen(false);
      setCsv("");
      setHeaders([]);
      setMapping({});
      setNotice(
        `اعتبارسنجی شد: ${faDigits(job.totalRows)} ردیف — ${faDigits(job.failedCount)} خطا. برای اجرا دکمهٔ «اجرا» را بزنید.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const openRows = useCallback(async (job: ImportJobDto) => {
    setRowsTarget(job);
    try {
      setRows(await fetchImportRows(job.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const run = async (job: ImportJobDto) => {
    setBusyId(job.id);
    setError(null);
    setNotice(null);
    try {
      const finished = await runImport(job.id);
      setNotice(
        `اجرا تمام شد: ${faDigits(finished.okCount)} ثبت، ${faDigits(finished.updatedCount)} به‌روزرسانی، ${faDigits(finished.duplicateCount)} تکراری، ${faDigits(finished.failedCount)} خطا.`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const cancel = async (job: ImportJobDto) => {
    setBusyId(job.id);
    setError(null);
    try {
      await cancelImport(job.id);
      setNotice("Job لغو شد.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const columns: DataTableColumn<ImportJobDto>[] = [
    { key: "file", header: "فایل", render: (j) => <span className="text-sm">{j.fileName}</span> },
    {
      key: "progress",
      header: "پیشرفت",
      render: (j) => (
        <span className="text-xs tabular-nums text-slate-600">
          {faDigits(j.okCount + j.failedCount + j.duplicateCount)} / {faDigits(j.totalRows)}
        </span>
      ),
    },
    {
      key: "counts",
      header: "ثبت/به‌روزرسانی/تکراری/خطا",
      align: "center",
      render: (j) => (
        <span className="text-xs tabular-nums">
          <span className="text-emerald-700">{faDigits(j.okCount)}</span> /{" "}
          <span className="text-sky-700">{faDigits(j.updatedCount)}</span> /{" "}
          <span className="text-slate-500">{faDigits(j.duplicateCount)}</span> /{" "}
          <span className="text-rose-700">{faDigits(j.failedCount)}</span>
        </span>
      ),
    },
    { key: "mode", header: "سیاست", align: "center", render: (j) => <span className="text-xs text-slate-500">{j.commitMode === "BATCH" ? "دسته‌ای" : "ردیفی"}</span> },
    {
      key: "status",
      header: "وضعیت",
      align: "center",
      render: (j) => (
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_BADGES[j.status]}`}>
          {STATUS_LABELS[j.status]}
        </span>
      ),
    },
    {
      key: "createdAt",
      header: "تاریخ",
      render: (j) => <span className="text-xs tabular-nums text-slate-600">{jalaliDateTime(j.createdAt)}</span>,
    },
    {
      key: "actions",
      header: "اقدام",
      align: "center",
      render: (j) => (
        <div className="flex justify-center gap-1">
          {["VALIDATED", "PARTIALLY_FAILED", "RUNNING"].includes(j.status) && (
            <Button size="sm" variant="primary" disabled={busyId === j.id} onClick={() => void run(j)}>
              اجرا
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void openRows(j)}>
            ردیف‌ها
          </Button>
          {["VALIDATED", "RUNNING"].includes(j.status) && (
            <Button size="sm" variant="ghost" disabled={busyId === j.id} onClick={() => void cancel(j)}>
              لغو
            </Button>
          )}
        </div>
      ),
    },
  ];

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-bold text-slate-800">ورود اطلاعات</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            CSV مانا و قابل ازسرگیری — اعتبارسنجی پیش از اجرا، گزارش خطای هر ردیف، بدون تراکنش بزرگ.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={`${process.env.NEXT_PUBLIC_API_URL || "http://localhost:3001/api"}/imports/sample?entityType=PARTY`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-700 hover:bg-slate-50"
          >
            دانلود نمونه CSV
          </a>
          <Button onClick={() => setCreateOpen(true)}>ورود جدید</Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}

      <DataTable columns={columns} rows={jobs} rowKey={(j) => j.id} loading={loading} emptyMessage="Jobی ثبت نشده است" />
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>
          مجموع {faDigits(total)} — صفحه {faDigits(page)} از {faDigits(totalPages)}
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            قبلی
          </Button>
          <Button variant="ghost" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            بعدی
          </Button>
        </div>
      </div>

      {/* create modal */}
      <Modal open={createOpen} title="ورود جدید (CSV طرف‌حساب‌ها)" onClose={() => setCreateOpen(false)}>
        <div className="space-y-3">
          <label className="block text-xs text-slate-600">
            فایل CSV
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void onFile(file);
              }}
              className="mt-1 block w-full text-sm"
            />
          </label>
          {headers.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-bold text-slate-700">تطبیق ستون‌ها</p>
              {PARTY_FIELDS.map((field) => (
                <div key={field} className="flex items-center gap-2 text-xs">
                  <span className="w-28 text-slate-600" dir="ltr">
                    {field}
                    {field === "nameFa" && <span className="text-rose-600"> *</span>}
                  </span>
                  <select
                    className="flex-1 rounded-md border border-slate-300 px-2 py-1"
                    value={mapping[field] ?? ""}
                    onChange={(e) => setMapping({ ...mapping, [field]: e.target.value })}
                  >
                    <option value="">—</option>
                    {headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-3 text-xs text-slate-600">
            <label className="flex cursor-pointer items-center gap-1">
              <input type="checkbox" checked={updateMatched} onChange={(e) => setUpdateMatched(e.target.checked)} className="h-4 w-4 accent-primary-600" />
              به‌روزرسانی ردیف‌های تکراری (بر اساس موبایل)
            </label>
            <label className="flex items-center gap-1">
              سیاست ثبت:
              <select className="rounded-md border border-slate-300 px-2 py-1" value={commitMode} onChange={(e) => setCommitMode(e.target.value as "PER_ROW" | "BATCH")}>
                <option value="PER_ROW">ردیفی (هر ردیف مستقل)</option>
                <option value="BATCH">دسته‌ای (کل دسته با هم)</option>
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setCreateOpen(false)}>
              انصراف
            </Button>
            <Button size="sm" disabled={creating || !csv.trim() || !mapping.nameFa} onClick={() => void submit()}>
              {creating ? "…" : "اعتبارسنجی و ثبت Job"}
            </Button>
          </div>
        </div>
      </Modal>

      {/* rows modal */}
      <Modal open={rowsTarget !== null} title={`ردیف‌ها — ${rowsTarget?.fileName ?? ""}`} onClose={() => setRowsTarget(null)}>
        <div className="max-h-96 space-y-1 overflow-auto">
          {rows.length === 0 && <p className="text-xs text-slate-500">ردیفی نیست.</p>}
          {rows.map((r) => (
            <div key={r.id} className="flex items-start justify-between gap-2 rounded border border-slate-100 px-2 py-1.5">
              <div className="text-xs">
                <span className="me-2 tabular-nums text-slate-400">#{faDigits(r.rowIndex + 1)}</span>
                <span dir="ltr" className="font-mono text-[11px] text-slate-600">
                  {Object.entries(r.payload ?? {})
                    .map(([k, v]) => `${k}=${String(v)}`)
                    .join(" | ")}
                </span>
              </div>
              <div className="text-left">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] ${
                    r.status === "OK"
                      ? "bg-emerald-100 text-emerald-800"
                      : r.status === "FAILED"
                        ? "bg-rose-100 text-rose-800"
                        : r.status === "DUPLICATE"
                          ? "bg-slate-100 text-slate-600"
                          : "bg-sky-100 text-sky-800"
                  }`}
                >
                  {ROW_STATUS_LABELS[r.status]}
                </span>
                {r.error && <p dir="ltr" className="mt-0.5 font-mono text-[10px] text-rose-600">{r.error}</p>}
              </div>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}
