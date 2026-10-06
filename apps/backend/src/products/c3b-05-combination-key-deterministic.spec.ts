import { buildCombinationKey } from './templates.service';

/**
 * c3b-05 — combination-key-deterministic: the canonical key is independent
 * of input order (sorted by attributeId, then attributeValueId), joined as
 * `attributeId=attributeValueId` with `|` — the exact format the p3b
 * corrections migration used for its DB backfill
 * (`string_agg(attribute_id || '=' || attribute_value_id, '|' ORDER BY
 * attribute_id, attribute_value_id)`).
 */
describe('c3b-05 combination-key-deterministic', () => {
  const SIZE = '11111111-1111-4111-8111-111111111111';
  const COLOR = '22222222-2222-4222-8222-222222222222';
  const V_RED = '33333333-3333-4333-8333-333333333333';
  const V_BLUE = '44444444-4444-4444-8444-444444444444';
  const V_M = '55555555-5555-4555-8555-555555555555';

  it('input order is irrelevant — every permutation yields the same key', () => {
    const a = [
      { attributeId: SIZE, attributeValueId: V_M },
      { attributeId: COLOR, attributeValueId: V_RED },
    ];
    const b = [
      { attributeId: COLOR, attributeValueId: V_RED },
      { attributeId: SIZE, attributeValueId: V_M },
    ];
    const c = [
      { attributeId: COLOR, attributeValueId: V_RED },
      { attributeId: SIZE, attributeValueId: V_M },
    ];
    expect(buildCombinationKey(a)).toBe(buildCombinationKey(b));
    expect(buildCombinationKey(b)).toBe(buildCombinationKey(c));
  });

  it('canonical form: attributeId=attributeValueId pairs sorted by attributeId then value, joined with |', () => {
    // SIZE (1111…) < COLOR (2222…) in byte order → SIZE first even though
    // the COLOR pair came first in the input.
    expect(
      buildCombinationKey([
        { attributeId: SIZE, attributeValueId: V_M },
        { attributeId: COLOR, attributeValueId: V_BLUE },
      ]),
    ).toBe(`${SIZE}=${V_M}|${COLOR}=${V_BLUE}`);

    // two different attributes sharing one value id still sort by
    // attributeId: SIZE (1111…) before COLOR (2222…).
    expect(
      buildCombinationKey([
        { attributeId: SIZE, attributeValueId: V_RED },
        { attributeId: COLOR, attributeValueId: V_RED },
      ]),
    ).toBe(`${SIZE}=${V_RED}|${COLOR}=${V_RED}`);
  });

  it('value ordering is by attributeValueId, not by pair position', () => {
    // value ordering is by attributeValueId: V_RED (3333…) < V_BLUE (4444…)
    const first = buildCombinationKey([
      { attributeId: SIZE, attributeValueId: V_RED },
    ]);
    const second = buildCombinationKey([
      { attributeId: SIZE, attributeValueId: V_BLUE },
    ]);
    expect(first < second).toBe(true);
    expect(first).toBe(`${SIZE}=${V_RED}`);
  });
});
