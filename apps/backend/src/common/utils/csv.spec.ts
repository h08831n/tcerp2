import { parseCsv, toCsv, normalizeHeader } from './csv';

describe('csv utils (Gate G)', () => {
  it('parses simple rows and skips the trailing empty row', () => {
    expect(parseCsv('a,b,c\r\n1,2,3\r\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles quoted fields with commas, doubled quotes and embedded newlines', () => {
    const csv = 'name,notes\r\n"فولاد, آریا","خط ""A"""\r\n"دو\r\nسطر",x';
    expect(parseCsv(csv)).toEqual([
      ['name', 'notes'],
      ['فولاد, آریا', 'خط "A"'],
      // RFC 4180: CRLF inside a quoted field is preserved verbatim
      ['دو\r\nسطر', 'x'],
    ]);
  });

  it('keeps empty fields and drops only fully-empty trailing rows', () => {
    expect(parseCsv('a,,c\n,,\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('serializes with minimal quoting and round-trips', () => {
    const rows = [
      ['nameFa', 'note'],
      ['شرکت فولاد', 'ساده'],
      ['کاما، داخل', 'کوتیشن "دابل"'],
    ];
    const csv = toCsv(rows);
    // ASCII comma forces quoting — the PERSIAN comma (،) does not
    expect(csv).toContain('"کوتیشن ""دابل"""');
    expect(parseCsv(csv)).toEqual(rows);
  });

  it('normalizes headers: BOM, whitespace, case', () => {
    expect(normalizeHeader('\uFEFF NameFa ')).toBe('namefa');
  });
});
