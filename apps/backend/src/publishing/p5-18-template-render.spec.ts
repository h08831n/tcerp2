import { renderBody } from './publishing-render';

/**
 * p5-18 template-render (pure, no DB): every known placeholder is replaced;
 * a placeholder the vars do not provide is left EMPTY and collected as a
 * warning; unknown-to-the-engine placeholders behave the same (never break
 * the send).
 */
describe('p5-18 template-render', () => {
  it('replaces all supported placeholders', () => {
    const { text, warnings } = renderBody(
      '{product} {variantSku} {size} {grade} {brand} — {price} {uom} ({date})',
      {
        product: 'میلگرد آجدار',
        variantSku: 'REBAR-16',
        size: '۱۶',
        grade: 'A3',
        brand: 'ذوب آهن',
        price: '34250',
        uom: 'kg',
        date: '2026-10-07',
      },
    );
    expect(text).toBe('میلگرد آجدار REBAR-16 ۱۶ A3 ذوب آهن — 34250 kg (2026-10-07)');
    expect(warnings).toEqual([]);
  });

  it('missing vars render empty and produce warnings', () => {
    const { text, warnings } = renderBody(
      '{product} {grade}: {price} {uom}',
      { product: 'میلگرد', price: '1000', uom: 'kg' },
    );
    expect(text).toBe('میلگرد : 1000 kg'); // {grade} left empty
    expect(warnings).toEqual(['Unknown placeholder {grade}']);
  });

  it('a template referencing an unknown placeholder is emptied with a warning', () => {
    const { text, warnings } = renderBody('hello {nope} {product}', { product: 'X' });
    expect(text).toBe('hello  X');
    expect(warnings).toEqual(['Unknown placeholder {nope}']);
  });

  it('null/undefined values render empty WITHOUT warnings (known placeholder)', () => {
    const { text, warnings } = renderBody('{product}/{brand}', { product: 'X', brand: null });
    expect(text).toBe('X/');
    expect(warnings).toEqual([]);
  });

  it('repeated placeholders are all replaced; text without placeholders passes through', () => {
    expect(renderBody('{p} and {p}', { p: '1' }).text).toBe('1 and 1');
    expect(renderBody('no placeholders here', {}).text).toBe('no placeholders here');
    expect(renderBody('no placeholders here', {}).warnings).toEqual([]);
  });
});
