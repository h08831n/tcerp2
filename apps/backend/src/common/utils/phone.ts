import { ValidationError } from '../errors';

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toAsciiDigits(input: string): string {
  return input
    .replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
}

/**
 * Normalize any reasonable Iranian mobile input to the canonical
 * `09XXXXXXXXX` form (REQUIREMENTS §75: `09121234567`, `+989121234567`, …
 * must normalize to the same canonical phone).
 *
 * Handles: 09…, 9…, +98…, 0098…, 98… prefixes, Persian/Arabic digits and
 * cosmetic separators (spaces, dashes, dots, parentheses, ZWNJ).
 * Throws ValidationError for anything that is not a valid Iranian mobile.
 */
export function normalizeIranMobile(input: string): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new ValidationError('Mobile number is required');
  }

  let s = toAsciiDigits(input.replace(/\u200c/g, '')).trim();
  s = s.replace(/[\s\-().]/g, '');

  if (s.startsWith('+98')) {
    s = `0${s.slice(3)}`;
  } else if (s.startsWith('0098')) {
    s = `0${s.slice(4)}`;
  } else if (s.startsWith('98') && s.length === 12) {
    s = `0${s.slice(2)}`;
  } else if (s.startsWith('9') && s.length === 10) {
    s = `0${s}`;
  }

  if (!/^09\d{9}$/.test(s)) {
    throw new ValidationError('Invalid Iranian mobile number', { received: input });
  }
  return s;
}
