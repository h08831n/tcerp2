"use client";

/**
 * CR-001 §10 — THE shared DateTimePicker (date + hour + minute).
 *
 * Used wherever a field stores an INSTANT (timestamptz): activity due/scheduled
 * dates, approval SLA edits, … The wall-clock shown is LOCAL time — identical
 * to the `<input type="datetime-local">` it replaces and to lib/format.ts's
 * jalaliDateTime() display, so what the user picks is exactly what the list
 * views show back. Stored value = ISO UTC instant string (same as before).
 *
 * Contract:
 *   value   : ISO datetime string | null
 *   onChange: (iso: string | null) => void
 */

import { useEffect, useMemo, useState } from "react";
import { DatePicker } from "./date-picker";
import { faDigits } from "@/lib/format";

export interface DateTimePickerProps {
  value: string | null;
  onChange: (iso: string | null) => void;
  min?: string | null;
  max?: string | null;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

function parts(value: string | null): { dateIso: string | null; hh: number; mm: number } {
  if (!value) return { dateIso: null, hh: 9, mm: 0 };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { dateIso: null, hh: 9, mm: 0 };
  const dateIso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return { dateIso, hh: d.getHours(), mm: d.getMinutes() };
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

export function DateTimePicker({
  value,
  onChange,
  min,
  max,
  placeholder = "انتخاب تاریخ و ساعت",
  disabled = false,
  required = false,
  id,
  className = "",
  "aria-label": ariaLabel,
}: DateTimePickerProps) {
  const initial = useMemo(() => parts(value), [value]);
  const [hh, setHh] = useState(initial.hh);
  const [mm, setMm] = useState(initial.mm);

  useEffect(() => {
    const p = parts(value);
    setHh(p.hh);
    setMm(p.mm);
  }, [value]);

  function emit(dateIso: string | null) {
    if (!dateIso) {
      onChange(null);
      return;
    }
    // LOCAL wall-clock composition → UTC instant (identical to the old
    // `new Date(datetimeLocalValue).toISOString()` round-trip).
    const [gy, gm, gd] = dateIso.split("-").map(Number);
    const d = new Date(gy, gm - 1, gd, hh, mm, 0, 0);
    onChange(d.toISOString());
  }

  return (
    <div className={`flex flex-wrap items-center gap-1 ${className}`} aria-label={ariaLabel}>
      <div className="min-w-[150px] flex-1">
        <DatePicker
          id={id}
          value={initial.dateIso}
          onChange={emit}
          min={min ? parts(min).dateIso : undefined}
          max={max ? parts(max).dateIso : undefined}
          disabled={disabled}
          required={required}
          allowToday
          clearable={!required}
          aria-label={ariaLabel ? `${ariaLabel} - تاریخ` : "تاریخ"}
        />
      </div>
      <div className="flex items-center gap-1">
        <select
          aria-label="ساعت"
          disabled={disabled}
          value={hh}
          onChange={(e) => {
            setHh(Number(e.target.value));
            if (initial.dateIso) emit(initial.dateIso);
          }}
          className="rounded-md border border-slate-300 px-1 py-1.5 text-sm disabled:bg-slate-100"
          dir="ltr"
        >
          {HOURS.map((h) => (
            <option key={h} value={h}>
              {faDigits(String(h).padStart(2, "0"))}
            </option>
          ))}
        </select>
        <span className="text-slate-400">:</span>
        <select
          aria-label="دقیقه"
          disabled={disabled}
          value={mm}
          onChange={(e) => {
            setMm(Number(e.target.value));
            if (initial.dateIso) emit(initial.dateIso);
          }}
          className="rounded-md border border-slate-300 px-1 py-1.5 text-sm disabled:bg-slate-100"
          dir="ltr"
        >
          {MINUTES.map((m) => (
            <option key={m} value={m}>
              {faDigits(String(m).padStart(2, "0"))}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

export default DateTimePicker;
