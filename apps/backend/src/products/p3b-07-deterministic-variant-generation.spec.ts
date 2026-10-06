import { TemplatesService, cartesianProduct, combinationKey } from './templates.service';

/**
 * p3b-07 — deterministic-variant-generation: the preview over a 3-sizes ×
 * 2-grades template returns exactly 6 combinations, identical across calls
 * (pure cartesian product; no randomness), with SKU suggestions built from
 * the template internal code + value codes.
 */
describe('p3b-07 deterministic-variant-generation', () => {
  const COMPANY = 'company-1';

  const SIZES = [
    { id: 'v-s', code: 'S', valueFa: 'کوچک' },
    { id: 'v-m', code: 'M', valueFa: 'متوسط' },
    { id: 'v-l', code: 'L', valueFa: 'بزرگ' },
  ];
  const GRADES = [
    { id: 'v-a', code: 'A', valueFa: 'درجه A' },
    { id: 'v-b', code: 'B', valueFa: 'درجه B' },
  ];

  const SPACE = [
    {
      attributeId: 'a-size',
      displayOrder: 1,
      attribute: {
        id: 'a-size',
        code: 'SIZE',
        nameFa: 'سایز',
        values: SIZES,
      },
    },
    {
      attributeId: 'a-grade',
      displayOrder: 2,
      attribute: {
        id: 'a-grade',
        code: 'GRADE',
        nameFa: 'درجه',
        values: GRADES,
      },
    },
  ];

  function makePrisma() {
    return {
      productTemplate: {
        findUnique: jest.fn(async () => ({
          id: 'tpl-1',
          companyId: COMPANY,
          internalCode: 'P-A12',
          nameFa: 'گوشی A12',
          active: true,
        })),
      },
      productTemplateAttribute: {
        findMany: jest.fn(async () => SPACE),
      },
      productVariant: { findMany: jest.fn(async () => []) },
    };
  }

  it('pure cartesian product: 3 sizes × 2 grades = 6 combinations', () => {
    const combos = cartesianProduct([
      { attributeId: 'a-size', valueIds: SIZES.map((s) => s.id) },
      { attributeId: 'a-grade', valueIds: GRADES.map((g) => g.id) },
    ]);
    expect(combos).toHaveLength(6);
    expect(combos[0]).toEqual([
      { attributeId: 'a-size', valueId: 'v-s' },
      { attributeId: 'a-grade', valueId: 'v-a' },
    ]);
    expect(combos[5]).toEqual([
      { attributeId: 'a-size', valueId: 'v-l' },
      { attributeId: 'a-grade', valueId: 'v-b' },
    ]);
    // every combination is unique
    expect(new Set(combos.map(combinationKey)).size).toBe(6);
  });

  it('preview returns the full product with SKU suggestions; stable across calls', async () => {
    const prisma = makePrisma();
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    const dto = {
      selections: [
        { attributeId: 'a-size', valueIds: SIZES.map((s) => s.id) },
        { attributeId: 'a-grade', valueIds: GRADES.map((g) => g.id) },
      ],
    };

    const first = (await service.previewVariants(COMPANY, 'tpl-1', dto)) as {
      combinations: Array<{
        combination: Array<{ attributeId: string; valueId: string; valueCode: string }>;
        skuSuggestion: string;
        existsAlready: boolean;
      }>;
    };
    const second = await service.previewVariants(COMPANY, 'tpl-1', dto);

    expect(first.combinations).toHaveLength(6);
    expect(second).toEqual(first); // deterministic
    expect(first.combinations[0].skuSuggestion).toBe('P-A12-S-A');
    expect(first.combinations[0].combination).toEqual([
      { attributeId: 'a-size', attributeCode: 'SIZE', valueId: 'v-s', valueCode: 'S' },
      { attributeId: 'a-grade', attributeCode: 'GRADE', valueId: 'v-a', valueCode: 'A' },
    ]);
    expect(first.combinations.every((c) => c.existsAlready === false)).toBe(true);
  });

  it('selections restricted to createsVariants attributes of the template', async () => {
    const prisma = makePrisma();
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    await expect(
      service.previewVariants(COMPANY, 'tpl-1', {
        selections: [{ attributeId: 'a-not-on-template', valueIds: ['v-x'] }],
      }),
    ).rejects.toMatchObject({
      message: 'Attribute does not create variants on this template',
    });
  });
});
