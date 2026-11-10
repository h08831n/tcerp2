"use client";

/**
 * CR-001 §10 — THE shared TimePicker (hour + minute, no date).
 *
 * Contract:
 *   value   : «HH:mm» (24h, latin) | null
 *   onChange: (hhmm: string | null) => void
 */

import { faDigits } from "@/lib/format";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

export interface TimePickerProps {
  value: string | null;
  onChange: (hhmm: string | null) => void;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  "aria-label"?: string;
}

export function TimePicker({
  value,
  onChange,
  disabled = false,
  required = false,
  id,
  className = "",
  "aria-label": ariaLabel,
}: TimePickerProps) {
  const [hh = "09", mm = "00"] = (value ?? "").split(":");
  const hour = Number(hh);
  const minute = Number(mm);

  function emit(h: number, m: number) {
    if (Number.isNaN(h) || Number.isNaN(m)) {
      onChange(null);
      return;
    }
    onChange(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
  }

  return (
    <div className={`flex items-center gap-1 ${className}`} aria-label={ariaLabel}>
      <select
        id={id}
        aria-label={ariaLabel ? `${ariaLabel} - ساعت` : "ساعت"}
        disabled={disabled}
        required={required}
        value={Number.isNaN(hour) ? "" : hour}
        onChange={(e) => emit(Number(e.target.value), minute)}
        className="rounded-md border border-slate-300 px-1 py-1.5 text-sm disabled:bg-slate-100"
        dir="ltr"
      >
        {!Number.isNaN(hour) || <option value="">--</option>}
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {faDigits(String(h).padStart(2, "0"))}
          </option>
        ))}
      </select>
      <span className="text-slate-400">:</span>
      <select
        aria-label={ariaLabel ? `${ariaLabel} - دقیقه` : "دقیقه"}
        disabled={disabled}
        required={required}
        value={Number.isNaN(minute) ? "" : minute}
        onChange={(e) => emit(hour, Number(e.target.value))}
        className="rounded-md border border-slate-300 px-1 py-1.5 text-sm disabled:bg-slate-100"
        dir="ltr"
      >
        {!Number.isNaN(minute) || <option value="">--</option>}
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {faDigits(String(m).padStart(2, "0"))}
          </option>
        ))}
      </select>
    </div>
  );
}

export default TimePicker;
