import { ValidationError } from '../common/errors';

/**
 * Canonical DAY handling for date-only columns (Phase 5 daily prices,
 * publish batch priceDate, automation run keys).
 *
 * Convention: a "day" is the calendar day in the SERVER's local timezone.
 * Stored values are normalized to UTC midnight of that day-key so the
 * Postgres `date` cast is timezone-independent (Prisma sessions run UTC)
 * and the DailyPrice unique key (company, variant, date, uom) is stable no
 * matter when during the day the row is written.
 */

/** `YYYY-MM-DD` key of a Date in the server's LOCAL calendar. */
export function dayKeyOf(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Today's day-key (local calendar). */
export function todayKey(): string {
  return dayKeyOf(new Date());
}

/**
 * Parse a `YYYY-MM-DD` key (or full ISO date — the day part is taken) into
 * the canonical UTC-midnight Date. Throws ValidationError for garbage input.
 */
export function parseDayKey(input: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(input ?? '').trim());
  if (!match) {
    throw new ValidationError('Invalid date, expected YYYY-MM-DD', { received: input });
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new ValidationError('Invalid calendar date', { received: input });
  }
  return date;
}

/** Day-key → canonical UTC-midnight Date (inverse of dayKeyOf for stored rows). */
export function dayFromKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** Day-key of a STORED date-only value (rows come back as UTC midnight). */
export function storedDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Shift a day-key by N days (DST-safe: operates on UTC midnights). */
export function shiftDayKey(key: string, days: number): string {
  const date = dayFromKey(key);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Canonical UTC-midnight Date for "today" (local calendar). */
export function todayUtc(): Date {
  return dayFromKey(todayKey());
}
