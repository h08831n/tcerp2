import {
  formatJalali,
  isJalaliLeapYear,
  jalaliToGregorian,
  jalaliYear,
  toJalali,
} from './jalali';

describe('jalali conversion', () => {
  describe('hard-known dates', () => {
    it('maps Nowruz 2026 to 1405/01/01', () => {
      const d = new Date(2026, 2, 21); // 21 March 2026
      expect(toJalali(d)).toEqual({ jy: 1405, jm: 1, jd: 1 });
      expect(formatJalali(d)).toBe('1405/01/01');
    });

    it('maps Nowruz 2025 to 1404/01/01', () => {
      const d = new Date(2025, 2, 21);
      expect(toJalali(d)).toEqual({ jy: 1404, jm: 1, jd: 1 });
    });

    it('maps 2024-03-20 (Nowruz 1403) to 1403/01/01 — 1403 leap year starts a day early', () => {
      const d = new Date(2024, 2, 20);
      expect(toJalali(d)).toEqual({ jy: 1403, jm: 1, jd: 1 });
    });

    it('maps 2025-03-20 (end of leap 1403) to 1403/12/30', () => {
      const d = new Date(2025, 2, 20);
      expect(toJalali(d)).toEqual({ jy: 1403, jm: 12, jd: 30 });
    });

    it('knows 1403 is a Jalali leap year and 1404 is not', () => {
      expect(isJalaliLeapYear(1403)).toBe(true);
      expect(isJalaliLeapYear(1404)).toBe(false);
      expect(isJalaliLeapYear(1399)).toBe(true);
    });

    it('mid-year sample: 2024-08-03 → 1403/05/13', () => {
      const d = new Date(2024, 7, 3);
      expect(toJalali(d)).toEqual({ jy: 1403, jm: 5, jd: 13 });
    });
  });

  describe('round-trip gregorian ↔ jalali', () => {
    const dates = [
      new Date(2023, 0, 1),
      new Date(2023, 2, 20), // Nowruz eve 1401
      new Date(2023, 2, 21), // Nowruz 1402
      new Date(2023, 11, 31),
      new Date(2024, 1, 29), // gregorian leap day
      new Date(2024, 2, 19), // 1402/12/29
      new Date(2024, 2, 20), // 1402/12/30 (1402 leap-year end per algorithm cycle)
      new Date(2024, 8, 22),
      new Date(2025, 2, 20), // 1403/12/29
      new Date(2025, 2, 21), // Nowruz 1404
      new Date(2025, 11, 25),
      new Date(2026, 2, 21), // Nowruz 1405
      new Date(2026, 6, 1),
      new Date(2026, 11, 30),
    ];

    it.each(dates.map((d) => [d.toISOString(), d] as const))(
      'round-trips %s',
      (_label, date) => {
        const j = toJalali(date);
        const back = jalaliToGregorian(j.jy, j.jm, j.jd);
        expect(back.getFullYear()).toBe(date.getFullYear());
        expect(back.getMonth()).toBe(date.getMonth());
        expect(back.getDate()).toBe(date.getDate());
      },
    );

    it('round-trips an Esfand-30 day of a Jalali leap year (1403/12/30)', () => {
      const back = jalaliToGregorian(1403, 12, 30);
      expect(toJalali(back)).toEqual({ jy: 1403, jm: 12, jd: 30 });
    });
  });

  describe('formatJalali / jalaliYear', () => {
    it('supports custom patterns', () => {
      const d = new Date(2026, 2, 21);
      expect(formatJalali(d, 'YYYY-MM-DD')).toBe('1405-01-01');
      expect(formatJalali(d, 'YY/M/D')).toBe('05/1/1');
    });

    it('jalaliYear returns the Jalali year of a date', () => {
      expect(jalaliYear(new Date(2026, 0, 15))).toBe(1404); // still 1404 in Dey
      expect(jalaliYear(new Date(2026, 2, 21))).toBe(1405);
    });
  });
});
