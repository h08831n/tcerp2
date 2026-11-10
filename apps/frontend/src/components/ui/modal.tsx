"use client";

import { useEffect, useRef, type ReactNode } from "react";

export interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Narrow modal for confirm dialogs. */
  small?: boolean;
}

/**
 * Dependency-free modal: Esc closes, backdrop click closes, focus moves to
 * the panel on open and is restored on close.
 */
export function Modal({ open, title, onClose, children, footer, small = false }: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // BUG-001 (root cause): pages pass `onClose={() => setState(false)}` — a NEW
  // function identity on EVERY render. With `onClose` in the effect deps, the
  // effect re-ran on every keystroke (form state lives in the page component)
  // and `panelRef.current?.focus()` stole focus from the input after the
  // FIRST character — the reported focus-loss bug. Hold the LATEST handler in
  // a ref so the effect depends ONLY on the `open` transition: it runs once
  // per open, focuses the panel once, and never re-focuses mid-typing.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    // Never steal focus when it is already inside the panel (e.g. the opener
    // focused an input before the effect ran).
    if (!panelRef.current?.contains(document.activeElement)) {
      panelRef.current?.focus();
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Runs ONLY on the open→false transition now: focus is restored once,
      // on close — never during typing.
      previousFocusRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-slate-900/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative flex max-h-[85vh] w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl focus:outline-none ${
          small ? "max-w-md" : "max-w-2xl"
        }`}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-bold text-slate-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن"
            className="flex h-7 w-7 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="h-4 w-4"
              aria-hidden="true"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
