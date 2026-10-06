"use client";

import { useEffect, useState } from "react";
import { faDigits, jalaliLatin, jalaliToIso, parseJalaliText } from "@/lib/format";

export interface JalaliDateInputProps {
  /** ISO date string (YYYY-MM-DD) or null. */
  value: string | null;
  onChange: (iso: string | null) => void;
  id?: string;
  ariaLabel?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Renders error text when the typed value is invalid (default true). */
  showHint?: boolean;
}

/**
 * Simple Jalali date input accepting text like 1405/07/14 (Persian or latin
 * digits, / - . separators). Validates and converts to an ISO date via
 * onChange. Full calendar picker is not required this phase.
 */
export function JalaliDateInput({
  value,
  onChange,
  id,
  ariaLabel = "تاریخ شمسی",
  placeholder = "مثلاً ۱۴۰۵/۰۷/۱۴",
  disabled = false,
  showHint = true,
}: JalaliDateInputProps) {
  const [text, setText] = useState(() => jalaliLatin(value));
  const [touched, setTouched] = useState(false);

  // Sync when the value changes externally.
  useEffect(() => {
    setText(jalaliLatin(value));
  }, [value]);

  const parsed = text.trim() ? parseJalaliText(text) : null;
  const invalid = touched && text.trim().length > 0 && !parsed;

  function commit(nextText: string) {
    setText(nextText);
    const result = nextText.trim() ? parseJalaliText(nextText) : null;
    if (result) {
      onChange(jalaliToIso(result));
    } else if (!nextText.trim()) {
      onChange(null);
    }
    // Invalid values keep the previous ISO until corrected.
  }

  return (
    <div>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        dir="ltr"
        disabled={disabled}
        value={faDigits(text)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        onBlur={() => setTouched(true)}
        onChange={(event) => commit(event.target.value)}
        className={`w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-800 transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-slate-400 ${
          invalid
            ? "border-red-400 focus:border-red-500 focus:ring-red-500/20"
            : "border-slate-300 focus:border-primary-500 focus:ring-primary-500/20"
        }`}
      />
      {showHint && invalid && (
        <p className="mt-1 text-xs text-red-600">
          تاریخ نامعتبر است. قالب صحیح: ۱۴۰۵/۰۷/۱۴
        </p>
      )}
    </div>
  );
}
