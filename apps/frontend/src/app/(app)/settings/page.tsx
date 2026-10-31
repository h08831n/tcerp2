"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { faDigits, jalaliDateTime } from "@/lib/format";
import { apiJson } from "@/lib/api";

interface SettingDto {
  id: string;
  key: string;
  value: unknown;
  category: string;
  description: string | null;
  updatedAt: string;
}

export default function SettingsPage() {
  const [rows, setRows] = useState<SettingDto[]>([]);
  const [total, setTotal] = useState(0);
  const [category, setCategory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [noPermission, setNoPermission] = useState(false);

  // edit modal
  const [editTarget, setEditTarget] = useState<SettingDto | null>(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setNoPermission(false);
    try {
      const params = new URLSearchParams({ page: "1", pageSize: "100" });
      if (category) params.set("category", category);
      const res = await apiJson<{ items: SettingDto[]; total: number }>(
        `/settings?${params.toString()}`,
      );
      setRows(res.items);
      setTotal(res.total);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("FORBIDDEN") || message.includes("403")) setNoPermission(true);
      else setError(message);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (row: SettingDto) => {
    setEditTarget(row);
    setEditValue(typeof row.value === "string" ? row.value : JSON.stringify(row.value, null, 2));
  };

  const save = async () => {
    if (!editTarget) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      let value: unknown = editValue;
      try {
        value = JSON.parse(editValue);
      } catch {
        // keep as plain string
      }
      await apiJson("/settings", {
        method: "PUT",
        body: JSON.stringify({
          key: editTarget.key,
          value,
          category: editTarget.category,
        }),
      });
      setEditTarget(null);
      setNotice(`تنظیم «${editTarget.key}» ذخیره شد.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const columns: DataTableColumn<SettingDto>[] = [
    { key: "key", header: "کلید", render: (r) => <span dir="ltr" className="font-mono text-xs">{r.key}</span> },
    {
      key: "value",
      header: "مقدار",
      render: (r) => (
        <span dir="ltr" className="block max-w-md truncate font-mono text-[11px] text-slate-700">
          {typeof r.value === "string" ? r.value : JSON.stringify(r.value)}
        </span>
      ),
    },
    { key: "category", header: "دسته", render: (r) => <span className="text-xs">{r.category}</span> },
    { key: "description", header: "توضیح", render: (r) => <span className="text-xs text-slate-500">{r.description ?? "—"}</span> },
    {
      key: "updatedAt",
      header: "آخرین تغییر",
      render: (r) => <span className="text-xs tabular-nums text-slate-600">{jalaliDateTime(r.updatedAt)}</span>,
    },
    {
      key: "actions",
      header: "",
      align: "center",
      render: (r) => (
        <Button size="sm" variant="ghost" onClick={() => openEdit(r)}>
          ویرایش
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-bold text-slate-800">تنظیمات</h1>
        <div className="flex items-center gap-2">
          <Input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="فیلتر دسته…"
            className="max-w-40"
          />
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            اعمال
          </Button>
        </div>
      </div>

      {error && <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">{error}</div>}
      {notice && <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{notice}</div>}
      {noPermission && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          مشاهده تنظیمات نیازمند مجوز «settings.view» است.
        </div>
      )}

      {!noPermission && (
        <>
          <p className="text-xs text-slate-500">
            {faDigits(total)} تنظیم — مقادیر JSON معتبر ذخیره می‌شوند و هر تغییر Audit دارد.
          </p>
          <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={loading} emptyMessage="تنظیمی ثبت نشده است" />
        </>
      )}

      <Modal open={editTarget !== null} title={`ویرایش تنظیم — ${editTarget?.key ?? ""}`} onClose={() => setEditTarget(null)} small>
        <div className="space-y-3">
          <label className="block text-xs text-slate-600">
            مقدار (JSON یا متن)
            <textarea
              className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
              dir="ltr"
              rows={5}
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
            />
          </label>
          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <Button variant="secondary" size="sm" onClick={() => setEditTarget(null)}>
              انصراف
            </Button>
            <Button size="sm" disabled={saving} onClick={() => void save()}>
              {saving ? "…" : "ذخیره"}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
