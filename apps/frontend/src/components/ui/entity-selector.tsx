"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { apiFetch } from "@/lib/api";

export interface EntityOption {
  id: string;
  label: string;
  sublabel?: string;
}

export interface EntitySelectorProps {
  /**
   * Returns the API path for a search term, e.g. (q) => `/users?search=${q}`.
   * The response may be `{items:[...]}` or a bare array.
   */
  endpoint: (search: string) => string;
  /** Maps one raw API item to an option; return null to skip it. */
  mapItem?: (raw: unknown) => EntityOption | null;
  value: EntityOption | null;
  onChange: (value: EntityOption | null) => void;
  placeholder?: string;
  ariaLabel?: string;
  disabled?: boolean;
  /** Shown when a value is selected, before any new search. */
  emptySearchLabel?: string;
  debounceMs?: number;
}

function defaultMapItem(raw: unknown): EntityOption | null {
  const item = raw as Record<string, unknown>;
  const id = item?.id !== undefined ? String(item.id) : "";
  if (!id) return null;
  const name = [item.firstName, item.lastName]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ")
    .trim();
  const label = name || (typeof item.nameFa === "string" ? item.nameFa : "") ||
    (typeof item.username === "string" ? item.username : id);
  return {
    id,
    label,
    sublabel: typeof item.username === "string" ? item.username : undefined,
  };
}

/**
 * Autocomplete selector over an API list endpoint: debounced search,
 * ArrowUp/Down navigation, Enter to select, Escape to close.
 */
export function EntitySelector({
  endpoint,
  mapItem = defaultMapItem,
  value,
  onChange,
  placeholder = "جستجو…",
  ariaLabel,
  disabled = false,
  emptySearchLabel = "برای جستجو تایپ کنید",
  debounceMs = 300,
}: EntitySelectorProps) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<EntityOption[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function handleMouseDown(event: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (!term) {
      setOptions([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const response = await apiFetch(endpoint(term));
        const data = (await response.json()) as unknown;
        if (cancelled) return;
        const items = Array.isArray(data)
          ? data
          : Array.isArray((data as { items?: unknown[] })?.items)
            ? (data as { items: unknown[] }).items
            : [];
        setOptions(
          items
            .map((item) => mapItem(item))
            .filter((option): option is EntityOption => option !== null),
        );
        setError(null);
      } catch {
        if (!cancelled) {
          setOptions([]);
          setError("خطا در دریافت نتایج");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, debounceMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, endpoint, mapItem, debounceMs]);

  useEffect(() => {
    setActiveIndex(options.length > 0 ? 0 : -1);
  }, [options]);

  function select(option: EntityOption) {
    onChange(option);
    setQuery("");
    setOpen(false);
    inputRef.current?.blur();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActiveIndex((index) => Math.min(index + 1, options.length - 1));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      if (open && activeIndex >= 0 && options[activeIndex]) {
        event.preventDefault();
        select(options[activeIndex]);
      }
      return;
    }
    if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
      return;
    }
    if (event.key === "Backspace" && !query && value) {
      event.preventDefault();
      onChange(null);
    }
  }

  // Keep the active option scrolled into view.
  useEffect(() => {
    const list = listRef.current;
    if (!list || activeIndex < 0) return;
    const element = list.children[activeIndex] as HTMLElement | undefined;
    element?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showValue = value && !open;

  return (
    <div ref={rootRef} className="relative">
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={open ? "entity-selector-listbox" : undefined}
          aria-autocomplete="list"
          aria-label={ariaLabel ?? placeholder}
          disabled={disabled}
          value={showValue ? value.label : query}
          placeholder={value ? value.label : placeholder}
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 transition-colors focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400"
        />
        {value && !disabled && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute inset-y-0 end-2 my-auto flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            aria-label="حذف انتخاب"
            tabIndex={showValue ? 0 : -1}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-3.5 w-3.5"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <ul
          id="entity-selector-listbox"
          ref={listRef}
          role="listbox"
          aria-label={ariaLabel ?? placeholder}
          className="absolute z-40 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-slate-200 bg-white py-1 shadow-lg"
        >
          {error ? (
            <li className="px-3 py-2 text-xs text-red-600">{error}</li>
          ) : loading ? (
            <li className="px-3 py-2 text-xs text-slate-400">در حال جستجو…</li>
          ) : !query.trim() ? (
            <li className="px-3 py-2 text-xs text-slate-400">{emptySearchLabel}</li>
          ) : options.length === 0 ? (
            <li className="px-3 py-2 text-xs text-slate-400">نتیجه‌ای یافت نشد.</li>
          ) : (
            options.map((option, index) => (
              <li
                key={option.id}
                role="option"
                aria-selected={value?.id === option.id}
                onMouseDown={(event) => {
                  event.preventDefault();
                  select(option);
                }}
                onMouseEnter={() => setActiveIndex(index)}
                className={`cursor-pointer px-3 py-2 text-sm ${
                  index === activeIndex ? "bg-primary-50 text-primary-800" : "text-slate-700"
                }`}
              >
                <span className="block truncate font-medium">{option.label}</span>
                {option.sublabel && (
                  <span className="block truncate text-[11px] text-slate-400" dir="ltr">
                    {option.sublabel}
                  </span>
                )}
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
