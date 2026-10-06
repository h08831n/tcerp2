import { normalizeIranMobile } from '../common/utils/phone';
import { normalizePersianName } from '../common/utils/persian-name';

/**
 * p3a-02 — persian-arabic-digit normalization: phone and name utils turn
 * visually-identical Persian/Arabic input into one canonical form.
 */
describe('p3a-02 persian-arabic-digit-normalization', () => {
  describe('normalizeIranMobile', () => {
    it('normalizes Persian digits to the canonical 09XXXXXXXXX form', () => {
      expect(normalizeIranMobile('۰۹۱۲۱۲۳۴۵۶۷')).toBe('09121234567');
      expect(normalizeIranMobile('۰۹۱۲ ۱۲۳ ۴۵۶۷')).toBe('09121234567');
    });

    it('normalizes Arabic-Indic digits', () => {
      expect(normalizeIranMobile('٠٩١٢١٢٣٤٥٦٧')).toBe('09121234567');
    });

    it('normalizes +98 / 0098 / 98 / bare-9 prefixes to the same number', () => {
      const canonical = '09121234567';
      expect(normalizeIranMobile('+989121234567')).toBe(canonical);
      expect(normalizeIranMobile('00989121234567')).toBe(canonical);
      expect(normalizeIranMobile('989121234567')).toBe(canonical);
      expect(normalizeIranMobile('9121234567')).toBe(canonical);
      expect(normalizeIranMobile('0912-123-4567')).toBe(canonical);
      expect(normalizeIranMobile('(0912) 123 4567')).toBe(canonical);
    });

    it('rejects invalid mobiles', () => {
      expect(() => normalizeIranMobile('12345')).toThrow();
      expect(() => normalizeIranMobile('09121234')).toThrow();
      expect(() => normalizeIranMobile('')).toThrow();
    });
  });

  describe('normalizePersianName', () => {
    it('unifies Arabic Yeh (ي) and Kaf (ك) into Persian forms', () => {
      expect(normalizePersianName('كامران رياحی')).toBe('کامران ریاحی');
    });

    it('trims and collapses whitespace runs', () => {
      expect(normalizePersianName('  شرکت   پارس   فن  ')).toBe('شرکت پارس فن');
    });

    it('keeps آ (alef with madda) distinct from ا', () => {
      expect(normalizePersianName('آریا')).toBe('آریا');
      expect(normalizePersianName('آریا')).not.toBe(normalizePersianName('اریا'));
    });

    it('makes Arabic-script variants collapse to one comparison key', () => {
      const a = normalizePersianName('رياحی كارشناس');
      const b = normalizePersianName('ریاحی کارشناس');
      expect(a).toBe(b);
    });
  });
});
