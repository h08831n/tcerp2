/**
 * Persian text normalization for CRM name matching (Phase 3A).
 *
 * Used BEFORE pg_trgm similarity comparisons so that visually identical
 * Persian names written with different Unicode code points still match:
 *   - Arabic Yeh (ي U+064A)  → Persian Yeh (ی U+06CC)
 *   - Arabic Kaf (ك U+0643)  → Persian Kaf (ک U+06A9)
 *   - trim + collapse whitespace runs (incl. NBSP) to a single space.
 *
 * Deliberately NOT unified: آ (U+0622 Alef with madda) stays distinct from
 * ا/أ/إ — "آریا" and "اریا" are genuinely different names in Persian.
 */
export function normalizePersianName(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/ي/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
}
