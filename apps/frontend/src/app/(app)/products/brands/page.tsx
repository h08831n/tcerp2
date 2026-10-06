"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, type DataTableColumn, type DataTableSort } from "@/components/ui/data-table";
import { ProductsNav } from "@/components/products/nav";
import { StatusBadge } from "@/components/parties/badges";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits, jalali } from "@/lib/format";
import {
  attachmentDownloadUrl,
  createBrand,
  fetchBrands,
  productErrorMessage,
  updateBrand,
  uploadAttachment,
  type BrandDto,
} from "@/lib/product";

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

interface EditorState {
  mode: "create" | "edit";
  brand: BrandDto | null;
  code: string;
  nameFa: string;
  nameEn: string;
  active: boolean;
  logoFile: File | null;
}

export default function BrandsPage() {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<DataTableSort | null>(null);

  const [data, setData] = useState<{ items: BrandDto[]; total: number; page: number; pageSize: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      const term = searchInput.trim();
      setSearch((current) => {
        if (current !== term) setPage(1);
        return term;
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const query = useMemo(
    () => ({ page, pageSize: 20, search: search || undefined }),
    [page, search],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchBrands(query);
      setData(result);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  useEffect(() => {
    if (loading) return;
    const firstRow = tableWrapRef.current?.querySelector<HTMLTableRowElement>("tbody tr[tabindex]");
    firstRow?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  useEscClose(Boolean(editor), () => {
    setEditor(null);
    setFormError(null);
  }, openButtonRef);

  useEffect(() => {
    if (editor) firstFieldRef.current?.focus();
  }, [editor]);

  function openCreate() {
    setFormError(null);
    setEditor({ mode: "create", brand: null, code: "", nameFa: "", nameEn: "", active: true, logoFile: null });
  }

  function openEdit(brand: BrandDto) {
    setFormError(null);
    setEditor({
      mode: "edit",
      brand,
      code: brand.code,
      nameFa: brand.nameFa,
      nameEn: brand.nameEn ?? "",
      active: brand.active,
      logoFile: null,
    });
  }

  async function save() {
    if (!editor || saving) return;
    if (editor.mode === "create" && !editor.code.trim()) {
      setFormError("کد برند الزامی است.");
      return;
    }
    if (!editor.nameFa.trim()) {
      setFormError("نام فارسی برند الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      let brandId: string;
      if (editor.mode === "create") {
        const created = await createBrand({
          code: editor.code.trim(),
          nameFa: editor.nameFa.trim(),
          nameEn: editor.nameEn.trim() || undefined,
          active: editor.active,
        });
        brandId = created.id;
      } else if (editor.brand) {
        await updateBrand(editor.brand.id, {
          nameFa: editor.nameFa.trim(),
          nameEn: editor.nameEn.trim() || undefined,
          active: editor.active,
        });
        brandId = editor.brand.id;
      } else {
        return;
      }

      if (editor.logoFile) {
        const attachment = await uploadAttachment({
          file: editor.logoFile,
          entityType: "brand",
          entityId: brandId,
          category: "image",
          displayName: `لوگوی ${editor.nameFa.trim()}`,
        });
        await updateBrand(brandId, { logoAttachmentId: attachment.id });
      }

      setEditor(null);
      await load();
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  useEffect(() => {
    if (!editor) return;
    function handler(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, saving]);

  const handleSortChange = useCallback((next: DataTableSort) => {
    setSort(next);
  }, []);

  // The backend orders brands by nameFa asc; the code/createdAt sorts are
  // applied to the loaded page client-side.
  const rows = useMemo(() => {
    const items = [...(data?.items ?? [])];
    if (sort?.key === "code") {
      items.sort((a, b) =>
        sort.dir === "asc" ? a.code.localeCompare(b.code) : b.code.localeCompare(a.code),
      );
    } else if (sort?.key === "createdAt") {
      items.sort((a, b) => {
        const diff = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
        return sort.dir === "asc" ? diff : -diff;
      });
    }
    return items;
  }, [data, sort]);

  const columns = useMemo<DataTableColumn<BrandDto>[]>(
    () => [
      {
        key: "nameFa",
        header: "نام",
        render: (row) => (
          <div className="min-w-0">
            <span className="block truncate font-medium text-slate-800">{row.nameFa}</span>
            {row.nameEn && (
              <span className="block truncate text-[11px] text-slate-400" dir="ltr">{row.nameEn}</span>
            )}
          </div>
        ),
      },
      {
        key: "code",
        header: "کد",
        render: (row) => <span dir="ltr" className="block text-start tabular-nums text-slate-600">{row.code}</span>,
      },
      {
        key: "logo",
        header: "لوگو",
        render: (row) =>
          row.logoAttachmentId ? (
            <a
              href={attachmentDownloadUrl(row.logoAttachmentId)}
              className="text-xs text-primary-600 underline hover:text-primary-700"
            >
              دانلود
            </a>
          ) : (
            <span className="text-slate-400">—</span>
          ),
      },
      {
        key: "active",
        header: "وضعیت",
        align: "center",
        render: (row) => <StatusBadge archived={!row.active} />,
      },
      {
        key: "createdAt",
        header: "تاریخ ایجاد",
        render: (row) => <span className="tabular-nums text-slate-500">{jalali(row.createdAt)}</span>,
      },
      {
        key: "actions",
        header: "",
        align: "end",
        render: (row) => (
          <Button variant="ghost" size="sm" onClick={() => openEdit(row)}>
            ویرایش
          </Button>
        ),
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <ProductsNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">برندها</h2>
          <p className="mt-0.5 text-xs text-slate-500">مدیریت برند محصولات</p>
        </div>
        <Button ref={openButtonRef} size="sm" onClick={openCreate} aria-label="ایجاد برند جدید">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          برند جدید
        </Button>
      </div>

      {editor && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-bold text-slate-800">
            {editor.mode === "create" ? "برند جدید" : `ویرایش برند: ${editor.brand?.nameFa ?? ""}`}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="brand-code" className={fieldLabel}>
                کد {editor.mode === "create" ? "*" : "(غیرقابل تغییر)"}
              </label>
              <Input
                ref={firstFieldRef}
                id="brand-code"
                dir="ltr"
                disabled={editor.mode === "edit"}
                value={editor.code}
                onChange={(event) => setEditor({ ...editor, code: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="brand-nameFa" className={fieldLabel}>نام فارسی *</label>
              <Input
                id="brand-nameFa"
                value={editor.nameFa}
                onChange={(event) => setEditor({ ...editor, nameFa: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="brand-nameEn" className={fieldLabel}>نام لاتین</label>
              <Input
                id="brand-nameEn"
                dir="ltr"
                value={editor.nameEn}
                onChange={(event) => setEditor({ ...editor, nameEn: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="brand-logo" className={fieldLabel}>لوگو (تصویر)</label>
              <input
                id="brand-logo"
                type="file"
                accept="image/*"
                onChange={(event) => setEditor({ ...editor, logoFile: event.target.files?.[0] ?? null })}
                className="block w-full text-xs text-slate-600 file:me-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-slate-700 hover:file:bg-slate-200"
              />
              {editor.mode === "edit" && editor.brand?.logoAttachmentId && (
                <a
                  href={attachmentDownloadUrl(editor.brand.logoAttachmentId)}
                  className="mt-1 inline-block text-[11px] text-primary-600 underline"
                >
                  دانلود لوگوی فعلی
                </a>
              )}
            </div>
            <div className="flex items-end pb-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={editor.active}
                  onChange={(event) => setEditor({ ...editor, active: event.target.checked })}
                  className="h-4 w-4 accent-primary-600"
                />
                فعال
              </label>
            </div>
          </div>

          {formError && (
            <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
              {formError}
            </div>
          )}

          <div className="mt-4 flex items-center gap-3 border-t border-slate-100 pt-4">
            <Button onClick={() => void save()} disabled={saving}>
              {saving ? "در حال ذخیره…" : "ذخیره (Ctrl+S)"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditor(null);
                setFormError(null);
                openButtonRef.current?.focus();
              }}
              disabled={saving}
            >
              انصراف (Esc)
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="w-full sm:w-64">
          <label htmlFor="brand-search" className="mb-1 block text-xs font-medium text-slate-600">
            جستجو (نام، کد)
          </label>
          <Input
            id="brand-search"
            inputSize="sm"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="جستجو…"
            aria-label="جستجوی برندها"
          />
        </div>
      </div>

      {error && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}{" "}
          <button type="button" className="font-bold underline" onClick={() => setReloadToken((token) => token + 1)}>
            تلاش مجدد
          </button>
        </div>
      )}

      <div ref={tableWrapRef}>
        <DataTable<BrandDto>
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          sort={sort}
          onSortChange={handleSortChange}
          loading={loading}
          dense
          ariaLabel="فهرست برندها"
          emptyMessage="برندی ثبت نشده است."
          pagination={
            data
              ? {
                  page: data.page,
                  pageSize: data.pageSize,
                  total: data.total,
                  onPageChange: setPage,
                }
              : null
          }
        />
      </div>

      {data && (
        <p className="text-xs text-slate-400">مجموع {faDigits(data.total)} برند</p>
      )}
    </div>
  );
}
