"use client";

import { useEffect, type RefObject } from "react";

/**
 * Global Escape handler used by inline add/edit forms: closes the form and
 * returns focus to the control that opened it. Runs in capture phase so it
 * wins over nested Escape handlers (comboboxes etc.).
 */
export function useEscClose(
  open: boolean,
  onClose: () => void,
  restoreFocusRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    function handler(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        restoreFocusRef?.current?.focus();
      }
    }
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, onClose, restoreFocusRef]);
}
