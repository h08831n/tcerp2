"use client";

/**
 * CR-001 §10 — THE shared Jalali DatePicker (project-wide standard).
 *
 * Replaces the text-only JalaliDateInput AND the raw Gregorian
 * `<input type="date">` outliers. One component everywhere: popup calendar,
 * typed input, keyboard navigation, RTL, nullable, min/max, mobile-friendly.
 *
 * Contract (identical to the old JalaliDateInput — zero migration friction):
 *   value   : ISO date-only string «YYYY-MM-DD» | null   (NO timezone part —
 *             a DATE column never shifts days; R5-P1 policy)
 *   onChange: (iso: string | null) => void
 *
 * Display: Jalali (Shamsi) with Persian digits; typing accepts ۱۴۰۵/۰۷/۱۴ in
 * Persian or latin digits with / - . separators. Conversion lives in
 * lib/format.ts (local, dependency-free arithmetic — same source the rest of
 * the app and the /calendar page use, so ALL dates stay consistent).
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  faDigits,
  isJalaliLeap,
  jalaliLatin,
  jalaliMonthLength,
  jalaliToIso,
  parseJalaliText,
  toGregorian,
  toJalali,
} from "@/lib/format";

const MONTHS_FA = [
  "فروردین", "اردیبهشت", "خرداد", "تیر", "مرداد", "شهریور",
  "مهر", "آبان", "آذر", "دی", "بهمن", "اسفند",
];
// Saturday-first week (Iranian week): شنبه … جمعه
const WEEKDAYS_FA = ["ش", "ی", "د", "س", "چ", "پ", "ج"];

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Jalali week-day index of an ISO date (0 = شنبه … 6 = جمعه). */
function jWeekday(gy: number, gm: number, gd: number): number {
  // JS getDay: 0=Sunday … 6=Saturday  →  Iranian: 0=Saturday … 6=Friday
  return (new Date(gy, gm - 1, gd).getDay() + 1) % 7;
}

export interface DatePickerProps {
  value: string | null;
  onChange: (iso: string | null) => void;
  /** Inclusive lower bound, ISO date-only. */
  min?: string | null;
  /** Inclusive upper bound, ISO date-only. */
  max?: string | null;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  name?: string;
  className?: string;
  /** Show the «امروز» shortcut button (default true). */
  allowToday?: boolean;
  /** Show the ✕ clear button (default true). */
  clearable?: boolean;
  "aria-label"?: string;
}

export function DatePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "انتخاب تاریخ",
  disabled = false,
  required = false,
  id,
  name,
  className = "",
  allowToday = true,
  clearable = true,
  "aria-label": ariaLabel,
}: DatePickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string>(() => (value ? jalaliLatin(value) : ""));
  const [invalid, setInvalid] = useState(false);
  const listboxId = useId();

  // View state of the popup calendar (Jalali year/month).
  const initial = useMemo(() => {
    const iso = value ?? todayIso();
    const [gy, gm, gd] = iso.split("-").map(Number);
    const [jy, jm] = toJalali(gy, gm, gd);
    return { jy, jm };
  }, [value]);
  const [view, setView] = useState(initial);

  // Keep the visible text in sync when the prop changes externally
  // (round-trip safety: reopening a form never shows a stale value).
  useEffect(() => {
    setText(value ? jalaliLatin(value) : "");
    setInvalid(false);
  }, [value]);

  // Close on outside click / Esc.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        // Restore the committed value when closing without selection.
        setText(value ? jalaliLatin(value) : "");
        setInvalid(false);
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, value]);

  function commit(iso: string | null) {
    setText(iso ? jalaliLatin(iso) : "");
    setInvalid(false);
    onChange(iso);
  }

  function commitText(current: string) {
    const parsed = parseJalaliText(current);
    if (!parsed) {
      if (current.trim() === "") {
        commit(null);
        return;
      }
      // Never emit an invalid value — keep the previous one and flag.
      setInvalid(true);
      setText(value ? jalaliLatin(value) : "");
      return;
    }
    const iso = jalaliToIso(parsed);
    if ((min && iso < min) || (max && iso > max)) {
      setInvalid(true);
      setText(value ? jalaliLatin(value) : "");
      return;
    }
    commit(iso);
  }

  function shiftMonth(delta: number) {
    setView((v) => {
      let jy = v.jy;
      let jm = v.jm + delta;
      if (jm > 12) {
        jm = 1;
        jy += 1;
      } else if (jm < 1) {
        jm = 12;
        jy -= 1;
      }
      return { jy, jm };
    });
  }

  function shiftYear(delta: number) {
    setView((v) => ({ ...v, jy: v.jy + delta }));
  }

  function isDisabledIso(iso: string): boolean {
    return (min !== undefined && min !== null && iso < min) || (max !== undefined && max !== null && iso > max);
  }

  // Calendar grid for the viewed Jalali month (Saturday-first columns).
  const grid = useMemo(() => {
    const [gy, gm] = toGregorian(view.jy, view.jm, 1);
    const firstWeekday = jWeekday(gy, gm, 1);
    const length = jalaliMonthLength(view.jy, view.jm);
    const cells: Array<{ iso: string; jd: number } | null> = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= length; d++) {
      const [g2y, g2m, g2d] = toGregorian(view.jy, view.jm, d);
      cells.push({
        iso: `${g2y}-${String(g2m).padStart(2, "0")}-${String(g2d).padStart(2, "0")}`,
        jd: d,
      });
    }
    return cells;
  }, [view]);

  const today = todayIso();

  function openAtSelection() {
    setView(initial);
    setOpen(true);
    // Focus the popup for keyboard navigation.
    requestAnimationFrame(() => panelRef.current?.focus());
  }

  function selectIso(iso: string) {
    if (isDisabledIso(iso)) return;
    commit(iso);
    setOpen(false);
    inputRef.current?.focus();
  }

  function onPanelKey(e: React.KeyboardEvent) {
    const base = value ?? today;
    const [gy, gm, gd] = base.split("-").map(Number);
    const move = (deltaDays: number) => {
      const d = new Date(gy, gm - 1, gd + deltaDays);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      if (!isDisabledIso(iso)) commit(iso);
    };
    switch (e.key) {
      case "ArrowRight": // RTL: right = previous day
        move(-1);
        break;
      case "ArrowLeft":
        move(1);
        break;
      case "ArrowUp":
        move(-7);
        break;
      case "ArrowDown":
        move(7);
        break;
      case "PageUp":
        shiftMonth(-1);
        break;
      case "PageDown":
        shiftMonth(1);
        break;
      case "Enter":
        setOpen(false);
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div className="flex items-stretch">
        <input
          ref={inputRef}
          id={id}
          name={name}
          type="text"
          inputMode="numeric"
          dir="ltr"
          disabled={disabled}
          required={required}
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          className={`w-full rounded-l-md border px-2 py-1.5 text-sm disabled:bg-slate-100 disabled:text-slate-400 ${
            invalid ? "border-red-500 ring-1 ring-red-300" : "border-slate-300"
          }`}
          placeholder={placeholder}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => commitText(text)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitText((e.target as HTMLInputElement).value);
              setOpen(false);
            }
          }}
        />
        <button
          type="button"
          aria-label="باز کردن تقویم"
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={disabled}
          onClick={() => (open ? setOpen(false) : openAtSelection())}
          className="rounded-r-md border border-r-0 border-slate-300 bg-slate-50 px-2 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
        >
          📅
        </button>
      </div>

      {open && (
        <div
          ref={panelRef}
          id={listboxId}
          role="dialog"
          aria-label="تقویم جلالی"
          tabIndex={-1}
          className="absolute z-50 mt-1 w-72 rounded-lg border border-slate-200 bg-white p-2 shadow-lg outline-none"
        >
          <div className="mb-1 flex items-center justify-between gap-1">
            <button type="button" aria-label="سال قبل" onClick={() => shiftYear(-1)} className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100">
              «
            </button>
            <button type="button" aria-label="ماه قبل" onClick={() => shiftMonth(-1)} className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100">
              ‹
            </button>
            <div className="text-sm font-medium text-slate-700">
              {MONTHS_FA[view.jm - 1]} {faDigits(view.jy)}
            </div>
            <button type="button" aria-label="ماه بعد" onClick={() => shiftMonth(1)} className="rounded px-1.5 py-0.5 text-slate-600 hover:bg-slate-100">
              ›
            </button>
            <button type="button" aria-label="سال بعد" onClick={() => shiftYear(1)} className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-slate-100">
              »
            </button>
          </div>
          <div className="grid grid-cols-7 text-center text-[10px] text-slate-400">
            {WEEKDAYS_FA.map((d, i) => (
              <div key={i} className="py-0.5">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5 text-center text-sm" role="grid">
            {grid.map((cell, idx) =>
              cell === null ? (
                <div key={`x${idx}`} />
              ) : (
                <button
                  key={cell.iso}
                  type="button"
                  role="gridcell"
                  aria-selected={value === cell.iso}
                  disabled={isDisabledIso(cell.iso)}
                  onClick={() => selectIso(cell.iso)}
                  className={`mx-auto h-7 w-7 rounded text-[13px] leading-7 ${
                    value === cell.iso
                      ? "bg-primary-600 font-medium text-white"
                      : cell.iso === today
                        ? "bg-primary-50 text-primary-700"
                        : isDisabledIso(cell.iso)
                          ? "text-slate-300"
                          : "text-slate-700 hover:bg-slate-100"
                  }`}
                >
                  {faDigits(cell.jd)}
                </button>
              ),
            )}
          </div>
          <div className="mt-1 flex items-center justify-between border-t border-slate-100 pt-1">
            {allowToday ? (
              <button
                type="button"
                onClick={() => selectIso(today)}
                className="rounded px-2 py-1 text-xs text-primary-700 hover:bg-primary-50"
              >
                امروز
              </button>
            ) : (
              <span />
            )}
            {clearable && !required ? (
              <button
                type="button"
                onClick={() => {
                  commit(null);
                  setOpen(false);
                }}
                className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-slate-100"
              >
                پاک کردن
              </button>
            ) : (
              <span />
            )}
          </div>
        </div>
      )}
      {invalid && <p className="mt-0.5 text-[11px] text-red-600">تاریخ نامعتبر یا خارج از بازه مجاز است</p>}
    </div>
  );
}

export default DatePicker;
