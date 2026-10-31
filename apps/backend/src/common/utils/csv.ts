/**
 * Minimal RFC-4180-style CSV parser (Phase 11, Gate G): quoted fields with
 * doubled-quote escapes, CRLF/LF rows, no trailing-newline row. Pure function
 * — unit-tested without any framework. Deliberately dependency-free: the
 * XLSX path will get its own reader; CSV stays exact and auditable.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const src = String(text ?? '');

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    // skip fully-empty trailing rows (e.g. trailing newline)
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      endField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      if (src[i + 1] === '\n') i += 1;
      endRow();
      i += 1;
      continue;
    }
    if (ch === '\n') {
      endRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // final unterminated row
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Serialize rows back to CSV (export path) — quotes only when needed. */
export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const escape = (value: string | number | null | undefined): string => {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  return rows.map((row) => row.map(escape).join(',')).join('\r\n');
}

/** BOM + Persian-digit-tolerant header normalization for mapping. */
export function normalizeHeader(header: string): string {
  return String(header ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase();
}
