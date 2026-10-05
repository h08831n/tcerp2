import { ValidationError } from '../errors';
import { normalizeIranMobile } from './phone';

describe('normalizeIranMobile', () => {
  it('normalizes the canonical 09XXXXXXXXX form', () => {
    expect(normalizeIranMobile('09121234567')).toBe('09121234567');
  });

  it('normalizes +98 prefix', () => {
    expect(normalizeIranMobile('+989121234567')).toBe('09121234567');
  });

  it('normalizes 0098 prefix', () => {
    expect(normalizeIranMobile('00989121234567')).toBe('09121234567');
  });

  it('normalizes bare 98 prefix (12 digits total)', () => {
    expect(normalizeIranMobile('989121234567')).toBe('09121234567');
  });

  it('normalizes 9XXXXXXXXX (10 digits, no leading zero)', () => {
    expect(normalizeIranMobile('9121234567')).toBe('09121234567');
  });

  it('converts Persian digits', () => {
    expect(normalizeIranMobile('۰۹۱۲۱۲۳۴۵۶۷')).toBe('09121234567');
    expect(normalizeIranMobile('+۹۸۹۱۲۱۲۳۴۵۶۷')).toBe('09121234567');
  });

  it('converts Arabic digits', () => {
    expect(normalizeIranMobile('٠٩١٢١٢٣٤٥٦٧')).toBe('09121234567');
  });

  it('strips cosmetic separators', () => {
    expect(normalizeIranMobile('0912 123 4567')).toBe('09121234567');
    expect(normalizeIranMobile('0912-123-4567')).toBe('09121234567');
    expect(normalizeIranMobile('(0912) 123.4567')).toBe('09121234567');
    expect(normalizeIranMobile('0912\u200c1234567')).toBe('09121234567');
  });

  it('throws ValidationError for invalid numbers', () => {
    expect(() => normalizeIranMobile('12345')).toThrow(ValidationError);
    expect(() => normalizeIranMobile('08121234567')).toThrow(ValidationError);
    expect(() => normalizeIranMobile('0912123456')).toThrow(ValidationError);
    expect(() => normalizeIranMobile('091212345678')).toThrow(ValidationError);
  });

  it('throws ValidationError for empty input', () => {
    expect(() => normalizeIranMobile('')).toThrow(ValidationError);
    expect(() => normalizeIranMobile('   ')).toThrow(ValidationError);
  });
});
