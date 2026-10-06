import { Prisma } from '@prisma/client';
import { TemplatesService } from './templates.service';

/**
 * c3b-06 — explicit-weight-uom: weightPerUnit WITHOUT weightUomId is rejected
 * (WEIGHT_UOM_REQUIRED); a UOM outside the company's Weight category is
 * rejected (WEIGHT_CATEGORY_REQUIRED); a foreign-company UOM is rejected
 * (UOM_NOT_IN_COMPANY). A valid pair persists on the generated variant.
 */
describe('c3b-06 explicit-weight-uom', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const TEMPLATE_ID = '11111111-1111-4111-8111-111111111111';
  const ATTR = '22222222-2222-4222-8222-222222222222';
  const VALUE = '33333333-3333-4333-8333-333333333333';
  const KG = '44444444-4444-4444-8444-444444444444';
  const METER = '55555555-5555-4555-8555-555555555555';

  const SPACE = [
    {
      attributeId: ATTR,
      displayOrder: 1,
      attribute: {
        id: ATTR,
        code: 'SIZE',
        nameFa: 'سایز',
        values: [{ id: VALUE, code: 'M', valueFa: 'متوسط' }],
      },
      selectedValues: [
        { attributeValue: { id: VALUE, code: 'M', valueFa: 'متوسط' } },
      ],
    },
  ];

  const template = { id: TEMPLATE_ID, companyId: COMPANY, internalCode: 'P-6', nameFa: 'قالب', active: true };

  function makePrisma(weightUom: Record<string, unknown> | null) {
    const createdVariants: Record<string, unknown>[] = [];
    const trx = {
      productVariant: {
        findMany: jest.fn(async () => []),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `var-${createdVariants.length + 1}`, ...args.data };
          createdVariants.push(row);
          return row;
        }),
      },
    };
    const prisma = {
      productTemplate: { findUnique: jest.fn(async () => template) },
      productTemplateAttribute: { findMany: jest.fn(async () => SPACE) },
      uom: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (weightUom && args.where.id === weightUom.id) return weightUom;
          return null;
        }),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { recordTx: jest.fn(), record: jest.fn() };
    const service = new TemplatesService(prisma as never, audit as never);
    return { service, prisma, trx, createdVariants, audit };
  }

  const weightUom = (id: string, company: string, categoryCode: string) => ({
    id,
    companyId: company,
    categoryId: `cat-${categoryCode}`,
    category: { companyId: company, code: categoryCode },
  });

  const combo = (extra: Record<string, unknown> = {}) => ({
    combinations: [
      {
        selections: [{ attributeId: ATTR, valueId: VALUE }],
        ...extra,
      },
    ],
  });

  it('weightPerUnit without weightUomId → WEIGHT_UOM_REQUIRED (request fails fast)', async () => {
    const { service, prisma, trx } = makePrisma(weightUom(KG, COMPANY, 'WEIGHT'));
    await expect(
      service.generateVariants(COMPANY, TEMPLATE_ID, combo({ weightPerUnit: '18.7' }), { id: 'u1', username: 'a' }, {}),
    ).rejects.toMatchObject({ message: 'WEIGHT_UOM_REQUIRED' });
    // nothing was written
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(trx.productVariant.create).not.toHaveBeenCalled();
  });

  it('weightUom outside the Weight category (LENGTH) → WEIGHT_CATEGORY_REQUIRED', async () => {
    const { service } = makePrisma(weightUom(METER, COMPANY, 'LENGTH'));
    await expect(
      service.generateVariants(
        COMPANY,
        TEMPLATE_ID,
        combo({ weightPerUnit: '18.7', weightUomId: METER }),
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toMatchObject({
      message: 'WEIGHT_CATEGORY_REQUIRED',
      details: { categoryCode: 'LENGTH' },
    });
  });

  it('weightUom of ANOTHER company → UOM_NOT_IN_COMPANY (c3b-10 weight path)', async () => {
    const { service } = makePrisma(weightUom(KG, 'company-OTHER', 'WEIGHT'));
    await expect(
      service.generateVariants(
        COMPANY,
        TEMPLATE_ID,
        combo({ weightPerUnit: '18.7', weightUomId: KG }),
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'UOM_NOT_IN_COMPANY' });
  });

  it('a valid Weight-category pair persists weightPerUnit + weightUomId on the variant', async () => {
    const { service, createdVariants } = makePrisma(weightUom(KG, COMPANY, 'WEIGHT'));
    const result = (await service.generateVariants(
      COMPANY,
      TEMPLATE_ID,
      combo({ weightPerUnit: '18.7', weightUomId: KG }),
      { id: 'u1', username: 'a' },
      {},
    )) as { created: unknown[] };
    expect(result.created).toHaveLength(1);
    expect(createdVariants[0]).toMatchObject({
      weightUomId: KG,
      combinationKey: `${ATTR}=${VALUE}`,
    });
    expect((createdVariants[0].weightPerUnit as Prisma.Decimal).toString()).toBe('18.7');
  });
});
