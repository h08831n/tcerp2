/**
 * Persian display helpers: digit conversion, Jalali (Shamsi) dates and money
 * formatting. The Gregorian -> Jalali conversion is implemented locally
 * (no dependency) using the well-known arithmetic algorithm.
 */

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Converts latin digits in a string/number to Persian digits. */
export function faDigits(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/** Converts Persian/Arabic digits in a string back to latin digits. */
export function enDigits(value: string): string {
  return value
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

// ---------------------------------------------------------------------------
// Jalali conversion
// ---------------------------------------------------------------------------

/** Gregorian -> Jalali. Returns [jy, jm, jd]. */
export function toJalali(gy: number, gm: number, gd: number): [number, number, number] {
  const gDaysInMonth = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  let jy = gy <= 1600 ? 0 : 979;
  gy -= gy <= 1600 ? 621 : 1600;
  const gy2 = gm > 2 ? gy + 1 : gy;
  let days =
    365 * gy +
    Math.floor((gy2 + 3) / 4) -
    Math.floor((gy2 + 99) / 100) +
    Math.floor((gy2 + 399) / 400) -
    80 +
    gd +
    gDaysInMonth[gm - 1];
  jy += 33 * Math.floor(days / 12053);
  days %= 12053;
  jy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    jy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  const jm = days < 186 ? 1 + Math.floor(days / 31) : 7 + Math.floor((days - 186) / 30);
  const jd = 1 + (days < 186 ? days % 31 : (days - 186) % 30);
  return [jy, jm, jd];
}

/** Jalali -> Gregorian. Returns [gy, gm, gd]. */
export function toGregorian(jy: number, jm: number, jd: number): [number, number, number] {
  let gy = jy <= 979 ? 621 : 1600;
  jy -= jy <= 979 ? 0 : 979;
  let days =
    365 * jy +
    Math.floor(jy / 33) * 8 +
    Math.floor(((jy % 33) + 3) / 4) +
    78 +
    jd +
    (jm < 7 ? (jm - 1) * 31 : (jm - 7) * 30 + 186);
  gy += 400 * Math.floor(days / 146097);
  days %= 146097;
  if (days > 36524) {
    gy += 100 * Math.floor(--days / 36524);
    days %= 36524;
    if (days >= 365) days++;
  }
  gy += 4 * Math.floor(days / 1461);
  days %= 1461;
  if (days > 365) {
    gy += Math.floor((days - 1) / 365);
    days = (days - 1) % 365;
  }
  let gd = days + 1;
  const leap = (gy % 4 === 0 && gy % 100 !== 0) || gy % 400 === 0;
  const gDaysInMonth = [0, 31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let gm = 0;
  while (gm < 12 && gd > gDaysInMonth[gm + 1]) {
    gd -= gDaysInMonth[gm + 1];
    gm++;
  }
  gm++;
  return [gy, gm, gd];
}

/** Jalali leap year (33-year cycle approximation used by the algorithm). */
export function isJalaliLeap(jy: number): boolean {
  const remainder = jy % 33;
  return [1, 5, 9, 13, 17, 22, 26, 30].includes(remainder);
}

export function jalaliMonthLength(jy: number, jm: number): number {
  if (jm <= 6) return 31;
  if (jm <= 11) return 30;
  return isJalaliLeap(jy) ? 30 : 29;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Extracts the YYYY-MM-DD part of an ISO string without timezone shifts. */
function isoDateParts(iso: string): [number, number, number] | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Formats an ISO date (or Date) as a Persian-digit Jalali date, e.g. ۱۴۰۳/۰۷/۱۴. */
export function jalali(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  let parts: [number, number, number] | null;
  if (iso instanceof Date) {
    parts = [iso.getFullYear(), iso.getMonth() + 1, iso.getDate()];
  } else {
    parts = isoDateParts(iso);
  }
  if (!parts) return "—";
  const [jy, jm, jd] = toJalali(parts[0], parts[1], parts[2]);
  return faDigits(`${jy}/${pad2(jm)}/${pad2(jd)}`);
}

/** Formats an ISO datetime as Jalali date + local HH:mm, e.g. ۱۴۰۳/۰۷/۱۴ ۰۹:۳۰. */
export function jalaliDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "—";
  const date = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(date.getTime())) return jalali(iso instanceof Date ? undefined : iso);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  return `${jalali(date instanceof Date ? date : iso)} ${faDigits(time)}`;
}

/** Latin-digit Jalali date string (yyyy/mm/dd) from an ISO value; for inputs. */
export function jalaliLatin(iso: string | null | undefined): string {
  if (!iso) return "";
  const match = isoDateParts(iso);
  if (!match) return "";
  const [jy, jm, jd] = toJalali(match[0], match[1], match[2]);
  return `${jy}/${pad2(jm)}/${pad2(jd)}`;
}

export interface ParsedJalali {
  jy: number;
  jm: number;
  jd: number;
}

/**
 * Parses a user-typed Jalali date like 1405/07/14 (accepts - . / separators,
 * Persian digits, 2-digit day/month). Returns null when invalid.
 */
export function parseJalaliText(text: string): ParsedJalali | null {
  const normalized = enDigits(text).trim().replace(/[-.]/g, "/");
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(normalized);
  if (!match) return null;
  const jy = Number(match[1]);
  const jm = Number(match[2]);
  const jd = Number(match[3]);
  if (jy < 1000 || jy > 1500) return null;
  if (jm < 1 || jm > 12) return null;
  if (jd < 1 || jd > jalaliMonthLength(jy, jm)) return null;
  return { jy, jm, jd };
}

/** Converts a parsed Jalali date to a plain ISO string (YYYY-MM-DD). */
export function jalaliToIso({ jy, jm, jd }: ParsedJalali): string {
  const [gy, gm, gd] = toGregorian(jy, jm, jd);
  return `${gy}-${pad2(gm)}-${pad2(gd)}`;
}

// ---------------------------------------------------------------------------
// Numbers / money
// ---------------------------------------------------------------------------

/** Thousand separators, latin digits, e.g. 1250000 -> "1,250,000". */
export function thousandSeparate(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  const negative = value < 0;
  const abs = Math.abs(Math.trunc(value));
  const grouped = String(abs).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}`;
}

/** Money format in Persian digits with thousand separators + ریال. */
export function faMoney(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${faDigits(thousandSeparate(value))} ریال`;
}

/**
 * Backend decimal columns (Prisma Decimal) arrive serialized as STRINGS.
 * This normalizes any money/quantity wire value to a JS number for display.
 */
export function toNum(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** Normalizes a mobile number to 09xxxxxxxxx (accepts +98 / 0098 / 9…). */
export function normalizeMobile(raw: string): string {
  let value = enDigits(raw).replace(/[\s()-]/g, "");
  if (value.startsWith("+98")) value = `0${value.slice(3)}`;
  else if (value.startsWith("0098")) value = `0${value.slice(4)}`;
  else if (value.startsWith("98") && value.length >= 12) value = `0${value.slice(2)}`;
  else if (value.startsWith("9") && value.length === 10) value = `0${value}`;
  return value;
}
