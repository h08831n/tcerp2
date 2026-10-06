"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ProductsNav } from "@/components/products/nav";
import { useEscClose } from "@/components/parties/use-esc-close";
import { faDigits } from "@/lib/format";
import {
  buildCategoryTree,
  createCategory,
  deleteCategory,
  fetchAllCategories,
  productErrorMessage,
  updateCategory,
  type CategoryDto,
  type CategoryNode,
} from "@/lib/product";

interface EditorState {
  mode: "create" | "edit";
  category: CategoryDto | null;
  parentId: string;
  code: string;
  nameFa: string;
  nameEn: string;
  description: string;
  sortOrder: string;
  active: boolean;
}

const fieldLabel = "mb-1 block text-xs font-medium text-slate-600";

function flattenTree(nodes: CategoryNode[], depth = 0, out: { node: CategoryNode; depth: number }[] = []) {
  for (const node of nodes) {
    out.push({ node, depth });
    flattenTree(node.children, depth + 1, out);
  }
  return out;
}

export default function CategoriesPage() {
  const [categories, setCategories] = useState<CategoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const treeRef = useRef<HTMLUListElement | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await fetchAllCategories("any");
      setCategories(items);
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(() => buildCategoryTree(categories), [categories]);
  const flat = useMemo(() => flattenTree(tree), [tree]);

  // Auto-expand roots when data first arrives.
  useEffect(() => {
    if (expanded.size === 0 && tree.length > 0) {
      setExpanded(new Set(tree.map((node) => node.category.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree.length]);

  // Esc closes the inline editor and restores focus.
  useEscClose(Boolean(editor), () => {
    setEditor(null);
    setFormError(null);
  }, openButtonRef);

  // Focus the first field when the editor opens.
  useEffect(() => {
    if (editor) firstFieldRef.current?.focus();
  }, [editor]);

  function openCreate(parentId: string = "", parentCategory?: CategoryDto) {
    if (parentCategory && parentCategory.id) {
      setExpanded((current) => new Set(current).add(parentCategory.id));
    }
    setFormError(null);
    setEditor({
      mode: "create",
      category: null,
      parentId,
      code: "",
      nameFa: "",
      nameEn: "",
      description: "",
      sortOrder: "0",
      active: true,
    });
  }

  function openEdit(category: CategoryDto) {
    setFormError(null);
    setEditor({
      mode: "edit",
      category,
      parentId: category.parentId ?? "",
      code: category.code,
      nameFa: category.nameFa,
      nameEn: category.nameEn ?? "",
      description: category.description ?? "",
      sortOrder: String(category.sortOrder),
      active: category.active,
    });
  }

  async function save() {
    if (!editor || saving) return;
    if (!editor.nameFa.trim()) {
      setFormError("نام فارسی گروه الزامی است.");
      return;
    }
    if (editor.mode === "create" && !editor.code.trim()) {
      setFormError("کد گروه الزامی است.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      if (editor.mode === "create") {
        await createCategory({
          code: editor.code.trim(),
          nameFa: editor.nameFa.trim(),
          nameEn: editor.nameEn.trim() || undefined,
          parentId: editor.parentId || undefined,
          description: editor.description.trim() || undefined,
          sortOrder: Number(editor.sortOrder) || 0,
          active: editor.active,
        });
      } else if (editor.category) {
        await updateCategory(editor.category.id, {
          parentId: editor.parentId || null,
          nameFa: editor.nameFa.trim(),
          nameEn: editor.nameEn.trim() || undefined,
          description: editor.description.trim() || undefined,
          sortOrder: Number(editor.sortOrder) || 0,
          active: editor.active,
        });
      }
      setEditor(null);
      setNotice("ذخیره شد.");
      await load();
    } catch (err) {
      setFormError(productErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  // Ctrl+S in the editor.
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

  async function handleDelete(category: CategoryDto) {
    if (deletingId) return;
    setDeletingId(category.id);
    setError(null);
    setNotice(null);
    try {
      await deleteCategory(category.id);
      setNotice("گروه حذف شد.");
      await load();
    } catch (err) {
      setError(productErrorMessage(err));
    } finally {
      setDeletingId(null);
    }
  }

  // Tree keyboard: ArrowUp/Down move between visible rows; in RTL ArrowLeft
  // expands (descends), ArrowRight collapses (ascends).
  function handleTreeKeyDown(event: ReactKeyboardEvent<HTMLUListElement>) {
    const rows = Array.from(
      treeRef.current?.querySelectorAll<HTMLLIElement>("li[data-node-id]") ?? [],
    );
    if (rows.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const index = current ? rows.indexOf(current.closest("li[data-node-id]") as HTMLLIElement) : -1;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? index + 1 : index - 1;
      const target = rows[Math.max(0, Math.min(next, rows.length - 1))];
      target?.querySelector<HTMLButtonElement>("[data-node-toggle]")?.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const li = rows[index];
      if (!li) return;
      const id = li.dataset.nodeId ?? "";
      const hasChildren = li.dataset.hasChildren === "true";
      event.preventDefault();
      if (event.key === "ArrowLeft") {
        if (hasChildren) setExpanded((set) => new Set(set).add(id));
      } else {
        setExpanded((set) => {
          const next = new Set(set);
          next.delete(id);
          return next;
        });
      }
    }
  }

  const visibleNodes = useMemo(
    () =>
      flat.filter(
        ({ node }) =>
          !node.category.parentId || expanded.has(node.category.parentId),
      ),
    [flat, expanded],
  );

  const parentOptions = useMemo(
    () => [
      { id: "", label: "— بدون والد (ریشه) —" },
      ...flat.map(({ node, depth }) => ({
        id: node.category.id,
        label: `${"— ".repeat(depth)}${node.category.nameFa} (${node.category.code})`,
      })),
    ],
    [flat],
  );

  return (
    <div className="space-y-4">
      <ProductsNav />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-slate-800">گروه‌های کالا</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            درخت سلسله‌مراتبی گروه‌ها — با کلیدهای جهت‌دار پیمایش کنید؛ چپ باز کردن، راست بستن
          </p>
        </div>
        <Button
          ref={openButtonRef}
          size="sm"
          onClick={() => openCreate()}
          aria-label="ایجاد گروه ریشه جدید"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          گروه جدید
        </Button>
      </div>

      {notice && !editor && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {notice}
        </div>
      )}
      {error && !editor && (
        <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Inline editor card */}
      {editor && (
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="mb-4 text-sm font-bold text-slate-800">
            {editor.mode === "create" ? "گروه جدید" : `ویرایش گروه: ${editor.category?.nameFa ?? ""}`}
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <div>
              <label htmlFor="cat-parent" className={fieldLabel}>گروه والد</label>
              <select
                id="cat-parent"
                value={editor.parentId}
                onChange={(event) => setEditor({ ...editor, parentId: event.target.value })}
                className="h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
              >
                {parentOptions
                  .filter((option) => option.id !== editor.category?.id)
                  .map((option) => (
                    <option key={option.id || "root"} value={option.id}>
                      {option.label}
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label htmlFor="cat-code" className={fieldLabel}>
                کد {editor.mode === "create" ? "*" : "(غیرقابل تغییر)"}
              </label>
              <Input
                ref={firstFieldRef}
                id="cat-code"
                dir="ltr"
                disabled={editor.mode === "edit"}
                value={editor.code}
                onChange={(event) => setEditor({ ...editor, code: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="cat-nameFa" className={fieldLabel}>نام فارسی *</label>
              <Input
                ref={editor.mode === "edit" ? firstFieldRef : undefined}
                id="cat-nameFa"
                value={editor.nameFa}
                onChange={(event) => setEditor({ ...editor, nameFa: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="cat-nameEn" className={fieldLabel}>نام لاتین</label>
              <Input
                id="cat-nameEn"
                dir="ltr"
                value={editor.nameEn}
                onChange={(event) => setEditor({ ...editor, nameEn: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="cat-sortOrder" className={fieldLabel}>ترتیب نمایش</label>
              <Input
                id="cat-sortOrder"
                dir="ltr"
                inputMode="numeric"
                value={editor.sortOrder}
                onChange={(event) => setEditor({ ...editor, sortOrder: event.target.value })}
              />
            </div>
            <div className="flex items-end gap-6 pb-1">
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
          <div className="mt-4">
            <label htmlFor="cat-description" className={fieldLabel}>توضیحات</label>
            <textarea
              id="cat-description"
              rows={2}
              value={editor.description}
              onChange={(event) => setEditor({ ...editor, description: event.target.value })}
              className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20"
            />
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

      {/* Tree */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        {loading ? (
          <p className="py-8 text-center text-sm text-slate-400">در حال بارگذاری…</p>
        ) : visibleNodes.length === 0 ? (
          <p className="py-8 text-center text-sm text-slate-400">
            گروهی ثبت نشده است. با دکمه «گروه جدید» اولین گروه را بسازید.
          </p>
        ) : (
          <ul ref={treeRef} onKeyDown={handleTreeKeyDown} className="space-y-0.5" aria-label="درخت گروه‌های کالا">
            {visibleNodes.map(({ node, depth }) => {
              const category = node.category;
              const hasChildren = node.children.length > 0 || category._count.children > 0;
              const isOpen = expanded.has(category.id);
              return (
                <li
                  key={category.id}
                  data-node-id={category.id}
                  data-has-children={hasChildren}
                  className="group rounded-md hover:bg-slate-50 focus-within:bg-slate-50"
                  style={{ paddingInlineStart: `${depth * 20}px` }}
                >
                  <div className="flex items-center gap-1.5 py-1 pe-2">
                    <button
                      type="button"
                      data-node-toggle
                      onClick={() =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          if (next.has(category.id)) next.delete(category.id);
                          else next.add(category.id);
                          return next;
                        })
                      }
                      disabled={!hasChildren}
                      aria-expanded={hasChildren ? isOpen : undefined}
                      aria-label={`${isOpen ? "بستن" : "باز کردن"} زیرگروه‌های ${category.nameFa}`}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:opacity-30"
                    >
                      {hasChildren ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                          strokeLinecap="round" className={`h-3.5 w-3.5 transition-transform ${isOpen ? "" : "rotate-180"}`}
                          aria-hidden="true">
                          <path d="M6 9l6 6 6-6" />
                        </svg>
                      ) : (
                        <span className="block h-1 w-1 rounded-full bg-slate-300" />
                      )}
                    </button>
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-800">
                      <span dir="ltr" className="me-2 text-[11px] tabular-nums text-slate-400">{category.code}</span>
                      {category.nameFa}
                      {category.nameEn && (
                        <span dir="ltr" className="ms-2 text-[11px] text-slate-400">{category.nameEn}</span>
                      )}
                      {!category.active && (
                        <span className="ms-2 rounded border border-red-200 bg-red-50 px-1 text-[10px] text-red-600">
                          بایگانی
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] text-slate-400">
                      {faDigits(category._count.templates)} محصول
                    </span>
                    <span className="hidden shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
                      <Button variant="ghost" size="sm" onClick={() => openCreate(category.id, category)}>
                        زیرگروه
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => openEdit(category)}>
                        ویرایش
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-red-600 hover:bg-red-50"
                        onClick={() => void handleDelete(category)}
                        disabled={deletingId === category.id}
                      >
                        حذف
                      </Button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
