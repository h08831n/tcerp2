"use client";

/**
 * DEPRECATED thin wrapper — kept ONLY as a compatibility shim.
 *
 * CR-001 §10 standardized ALL date entry on the shared, popup-calendar
 * `DatePicker` (components/ui/date-picker.tsx). This shim forwards the
 * legacy prop contract (ariaLabel/showHint) to DatePicker so the ~30
 * existing call sites gain the calendar without any per-page churn.
 *
 * NEW code must import DatePicker directly.
 */

import { DatePicker } from "./date-picker";

export interface JalaliDateInputProps {
  /** ISO date string (YYYY-MM-DD) or null. */
  value: string | null;
  onChange: (iso: string | null) => void;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Accepted for backward compatibility; DatePicker renders its own hint. */
  showHint?: boolean;
  min?: string | null;
  max?: string | null;
}

export function JalaliDateInput({
  value,
  onChange,
  id,
  ariaLabel,
  placeholder,
  disabled,
  showHint: _showHint,
  min,
  max,
}: JalaliDateInputProps) {
  void _showHint;
  return (
    <DatePicker
      value={value}
      onChange={onChange}
      id={id}
      aria-label={ariaLabel}
      placeholder={placeholder}
      disabled={disabled}
      min={min ?? undefined}
      max={max ?? undefined}
    />
  );
}

export default JalaliDateInput;
