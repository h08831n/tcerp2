"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { faDigits } from "@/lib/format";

export interface DataTableColumn<T> {
  /** Unique column key; also the sort key sent to the API when sortable. */
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
  sortable?: boolean;
  align?: "start" | "center" | "end";
  className?: string;
  headerClassName?: string;
}

export interface DataTableSort {
  key: string;
  dir: "asc" | "desc";
}

export interface DataTablePagination {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** When set, clicking a row (or pressing Enter) navigates to this href. */
  rowHref?: (row: T) => string;
  getRowAriaLabel?: (row: T) => string;
  sort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort) => void;
  loading?: boolean;
  dense?: boolean;
  selectable?: boolean;
  selectedKeys?: ReadonlySet<string>;
  onSelectedChange?: (keys: Set<string>) => void;
  loadingMessage?: string;
  emptyMessage?: string;
  pagination?: DataTablePagination | null;
  /** aria-label for the table element. */
  ariaLabel?: string;
  className?: string;
}

function SortIcon({ dir }: { dir: "asc" | "desc" | null }) {
  if (!dir) {
    return (
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-3 w-3 text-slate-300"
        aria-hidden="true"
      >
        <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
      </svg>
    );
  }
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3 w-3 ${dir === "asc" ? "" : "rotate-180"}`}
      aria-hidden="true"
    >
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

/**
 * Dependency-free generic data table.
 * - Sortable headers: clicking cycles asc -> desc (server-side via onSortChange).
 * - Keyboard row navigation: ArrowUp/Down move focus between rows, Enter opens
 *   the row link, Space toggles the row selection checkbox.
 * - Sticky header, dense mode, Persian loading/empty states, pagination footer.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  getRowAriaLabel,
  sort,
  onSortChange,
  loading = false,
  dense = false,
  selectable = false,
  selectedKeys,
  onSelectedChange,
  loadingMessage = "در حال بارگذاری…",
  emptyMessage = "رکوردی یافت نشد.",
  pagination = null,
  ariaLabel,
  className = "",
}: DataTableProps<T>) {
  const router = useRouter();
  const rowRefs = useRef<(HTMLTableRowElement | null)[]>([]);
  const [focusedIndex, setFocusedIndex] = useState(0);

  useEffect(() => {
    setFocusedIndex(0);
  }, [rows]);

  const focusRow = useCallback((index: number) => {
    const clamped = Math.max(0, Math.min(index, rows.length - 1));
    setFocusedIndex(clamped);
    rowRefs.current[clamped]?.focus();
  }, [rows.length]);

  function handleHeaderSort(column: DataTableColumn<T>) {
    if (!onSortChange) return;
    if (sort && sort.key === column.key) {
      onSortChange({ key: column.key, dir: sort.dir === "asc" ? "desc" : "asc" });
    } else {
      onSortChange({ key: column.key, dir: "asc" });
    }
  }

  function handleRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, index: number) {
    const target = event.target as HTMLElement;
    const interactive = target.closest("input,button,a,select,textarea,[role='button']");
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(index + 1);
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(index - 1);
      return;
    }
    if (interactive) return; // let inner controls handle Enter/Space
    if (event.key === "Enter" && rowHref) {
      event.preventDefault();
      router.push(rowHref(rows[index]));
      return;
    }
    if (event.key === " " && selectable && onSelectedChange && selectedKeys) {
      event.preventDefault();
      const key = rowKey(rows[index]);
      const next = new Set(selectedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      onSelectedChange(next);
    }
  }

  function toggleAll() {
    if (!onSelectedChange || !selectedKeys) return;
    const allSelected =
      rows.length > 0 && rows.every((row) => selectedKeys.has(rowKey(row)));
    if (allSelected) {
      onSelectedChange(new Set());
    } else {
      onSelectedChange(new Set(rows.map((row) => rowKey(row))));
    }
  }

  const cellPadding = dense ? "px-2.5 py-1.5" : "px-3 py-2.5";
  const allSelected =
    selectable && rows.length > 0 && !!selectedKeys &&
    rows.every((row) => selectedKeys.has(rowKey(row)));
  const someSelected =
    selectable && !!selectedKeys && !allSelected && selectedKeys.size > 0;

  const totalPages = pagination
    ? Math.max(1, Math.ceil(pagination.total / Math.max(1, pagination.pageSize)))
    : 1;

  return (
    <div className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <div className="max-w-full overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-sm" aria-label={ariaLabel}>
          <thead>
            <tr className="sticky top-0 z-10 bg-slate-50 shadow-[inset_0_-1px_0_0_theme(colors.slate.200)]">
              {selectable && (
                <th scope="col" className={`w-10 ${cellPadding} text-center`}>
                  <input
                    type="checkbox"
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected;
                    }}
                    onChange={toggleAll}
                    aria-label="انتخاب همه ردیف‌ها"
                    className="h-4 w-4 cursor-pointer accent-primary-600"
                  />
                </th>
              )}
              {columns.map((column) => {
                const isSorted = sort && sort.key === column.key;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    aria-sort={
                      isSorted
                        ? sort!.dir === "asc"
                          ? "ascending"
                          : "descending"
                        : undefined
                    }
                    className={`${cellPadding} text-xs font-semibold text-slate-500 ${
                      column.align === "center"
                        ? "text-center"
                        : column.align === "end"
                          ? "text-end"
                          : "text-start"
                    } ${column.headerClassName ?? ""}`}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => handleHeaderSort(column)}
                        className={`inline-flex items-center gap-1 rounded transition-colors hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                          isSorted ? "text-primary-700" : ""
                        }`}
                        aria-label={`مرتب‌سازی بر اساس ${typeof column.header === "string" ? column.header : column.key}`}
                      >
                        {column.header}
                        <SortIcon dir={isSorted ? sort!.dir : null} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className={`${cellPadding} py-10 text-center`}
                >
                  <span className="inline-flex items-center gap-2 text-sm text-slate-400">
                    <svg
                      className="h-5 w-5 animate-spin text-primary-500"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <circle
                        className="opacity-25"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        strokeWidth="4"
                      />
                      <path
                        className="opacity-75"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                      />
                    </svg>
                    {loadingMessage}
                  </span>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={columns.length + (selectable ? 1 : 0)}
                  className={`${cellPadding} py-10 text-center text-sm text-slate-400`}
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row, index) => {
                const key = rowKey(row);
                const selected = selectable && !!selectedKeys?.has(key);
                return (
                  <tr
                    key={key}
                    ref={(el) => {
                      rowRefs.current[index] = el;
                    }}
                    tabIndex={index === focusedIndex ? 0 : -1}
                    onKeyDown={(event) => handleRowKeyDown(event, index)}
                    onClick={(event) => {
                      if (!rowHref) return;
                      const target = event.target as HTMLElement;
                      if (target.closest("input,button,a,select,textarea,[role='button']")) return;
                      router.push(rowHref(row));
                    }}
                    aria-label={getRowAriaLabel ? getRowAriaLabel(row) : undefined}
                    className={`outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 ${
                      selected ? "bg-primary-50" : ""
                    } ${rowHref ? "cursor-pointer hover:bg-slate-50" : ""}`}
                  >
                    {selectable && (
                      <td className={`${cellPadding} text-center`}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            if (!onSelectedChange || !selectedKeys) return;
                            const next = new Set(selectedKeys);
                            if (next.has(key)) next.delete(key);
                            else next.add(key);
                            onSelectedChange(next);
                          }}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          aria-label={`انتخاب ردیف ${index + 1}`}
                          className="h-4 w-4 cursor-pointer accent-primary-600"
                        />
                      </td>
                    )}
                    {columns.map((column) => (
                      <td
                        key={column.key}
                        className={`${cellPadding} text-slate-700 ${
                          column.align === "center"
                            ? "text-center"
                            : column.align === "end"
                              ? "text-end"
                              : "text-start"
                        } ${column.className ?? ""}`}
                      >
                        {column.render
                          ? column.render(row)
                          : ((row as Record<string, unknown>)[column.key] as ReactNode)}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pagination && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-slate-50/60 px-3 py-2">
          <p className="text-xs text-slate-500">
            مجموع {faDigits(pagination.total)} رکورد — صفحه{" "}
            {faDigits(Math.min(pagination.page, totalPages))} از {faDigits(totalPages)}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pagination.page <= 1}
              onClick={() => pagination.onPageChange(pagination.page - 1)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="صفحه قبل"
            >
              قبلی
            </button>
            <button
              type="button"
              disabled={pagination.page >= totalPages}
              onClick={() => pagination.onPageChange(pagination.page + 1)}
              className="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-3 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40"
              aria-label="صفحه بعد"
            >
              بعدی
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
