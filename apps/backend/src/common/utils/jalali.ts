/**
 * Gregorian → Jalali (Shamsi) conversion — the standard "jalaali" algorithm
 * (as in jalaali-js), implemented locally with no external dependency.
 *
 * Dates are interpreted in the server's local timezone (the ERP UI is
 * Tehran-based); the database always stores ISO/UTC timestamps (REQUIREMENTS
 * §2.7) — conversion happens only for display/numbering.
 */

const BREAKS = [
  -61, 9, 38, 199, 426, 686, 756, 818, 1111, 1181, 1210, 1635, 2060, 2097, 2192,
  2262, 2324, 2394, 2456, 3178,
];

function div(a: number, b: number): number {
  return ~~(a / b);
}

function mod(a: number, b: number): number {
  return a - ~~(a / b) * b;
}

interface JalaliCal {
  leap: number;
  gy: number;
  march: number;
}

function jalCal(jy: number): JalaliCal {
  const breaksLength = BREAKS.length;
  const gy = jy + 621;
  let leapJ = -14;
  let jp = BREAKS[0];
  let jump = 0;
  if (jy < jp || jy >= BREAKS[breaksLength - 1]) {
    throw new Error(`Invalid Jalali year ${jy}`);
  }
  for (let i = 1; i < breaksLength; i += 1) {
    const jm = BREAKS[i];
    jump = jm - jp;
    if (jy < jm) break;
    leapJ = leapJ + div(jump, 33) * 8 + div(mod(jump, 33), 4);
    jp = jm;
  }
  let n = jy - jp;
  leapJ = leapJ + div(n, 33) * 8 + div(mod(n, 33) + 3, 4);
  if (mod(jump, 33) === 4 && jump - n === 4) leapJ += 1;

  const leapG = div(gy, 4) - div((div(gy, 100) + 1) * 3, 4) - 150;
  const march = 20 + leapJ - leapG;

  if (jump - n < 6) n = n - jump + div(jump + 4, 33) * 33;
  let leap = mod(mod(n + 1, 33) - 1, 4);
  if (leap === -1) leap = 4;

  return { leap, gy, march };
}

/** Gregorian date → Jalali day number (Julian-day style ordinal). */
function g2d(gy: number, gm: number, gd: number): number {
  let d =
    div((gy + div(gm - 8, 6) + 100100) * 1461, 4) +
    div(153 * mod(gm + 9, 12) + 2, 5) +
    gd -
    34840408;
  d = d - div(div(gy + 100100 + div(gm - 8, 6), 100) * 3, 4) + 752;
  return d;
}

/** Jalali day number → Gregorian date parts. */
function d2g(jdn: number): { gy: number; gm: number; gd: number } {
  let j = 4 * jdn + 139361631;
  j = j + div(div(4 * jdn + 183187720, 146097) * 3, 4) * 4 - 3908;
  const i = div(mod(j, 1461), 4) * 5 + 308;
  const gd = div(mod(i, 153), 5) + 1;
  const gm = mod(div(i, 153), 12) + 1;
  const gy = div(j, 1461) - 100100 + div(8 - gm, 6);
  return { gy, gm, gd };
}

/** Jalali day number → Jalali date parts. */
function d2j(jdn: number): { jy: number; jm: number; jd: number } {
  const gy = d2g(jdn).gy;
  let jy = gy - 621;
  const r = jalCal(jy);
  const jdn1f = g2d(r.gy, 3, r.march);
  let k = jdn - jdn1f;

  if (k >= 0) {
    if (k <= 185) {
      return { jy, jm: 1 + div(k, 31), jd: mod(k, 31) + 1 };
    }
    k -= 186;
  } else {
    jy -= 1;
    k += 179;
    if (r.leap === 1) k += 1;
  }
  return { jy, jm: 7 + div(k, 30), jd: mod(k, 30) + 1 };
}

/** Jalali date parts → Jalali day number. */
function j2d(jy: number, jm: number, jd: number): number {
  const r = jalCal(jy);
  return g2d(r.gy, 3, r.march) + (jm - 1) * 31 - div(jm, 7) * (jm - 7) + jd - 1;
}

export interface JalaliDate {
  jy: number;
  jm: number;
  jd: number;
}

/** Convert a JS Date (local calendar day) to its Jalali parts. */
export function toJalali(date: Date): JalaliDate {
  return d2j(g2d(date.getFullYear(), date.getMonth() + 1, date.getDate()));
}

/** Convert Jalali parts to a JS Date (local midnight of that day). */
export function jalaliToGregorian(jy: number, jm: number, jd: number): Date {
  const g = d2g(j2d(jy, jm, jd));
  return new Date(g.gy, g.gm - 1, g.gd);
}

/** Whether the given Jalali year is a leap year (Esfand has 30 days). */
export function isJalaliLeapYear(jy: number): boolean {
  return jalCal(jy).leap === 0;
}

/**
 * Format a Date as a Jalali string. Tokens: YYYY (or YY), MM (or M), DD (or D).
 * Default pattern yields e.g. `1405/07/13`.
 */
export function formatJalali(date: Date, pattern = 'YYYY/MM/DD'): string {
  const { jy, jm, jd } = toJalali(date);
  const tokens: Record<string, string> = {
    YYYY: String(jy).padStart(4, '0'),
    YY: String(jy).slice(-2),
    MM: String(jm).padStart(2, '0'),
    M: String(jm),
    DD: String(jd).padStart(2, '0'),
    D: String(jd),
  };
  return pattern.replace(/YYYY|YY|MM|DD|M|D/g, (t) => tokens[t]);
}

/** Jalali year for a given Date (shortcut used by the sequence engine). */
export function jalaliYear(date: Date): number {
  return toJalali(date).jy;
}
