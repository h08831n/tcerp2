import { AttributesService } from './attributes.service';

/**
 * p3b-05 — dynamic-attribute-creation: attributes and values are arbitrary
 * rows created at runtime — nothing hard-coded. Two different companies can
 * define completely different attributes; a custom attribute with arbitrary
 * codes/values round-trips through the service.
 */
describe('p3b-05 dynamic-attribute-creation', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'admin' };

  function makeService() {
    const createdAttributes: Record<string, unknown>[] = [];
    const createdValues: Record<string, unknown>[] = [];
    const trx = {
      attribute: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `attr-${createdAttributes.length + 1}`, ...args.data };
          createdAttributes.push(row);
          return row;
        }),
      },
      attributeValue: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `val-${createdValues.length + 1}`, ...args.data };
          createdValues.push(row);
          return row;
        }),
      },
    };
    const prisma = {
      attribute: {
        create: jest.fn(),
        findUnique: jest.fn(async (args: { where: { id: string } }) =>
          createdAttributes.find((a) => a.id === args.where.id) ?? null,
        ),
        count: jest.fn(async () => createdAttributes.length),
        findMany: jest.fn(async () =>
          createdAttributes.map((a) => ({ ...a, values: createdValues })),
        ),
      },
      attributeValue: {
        create: jest.fn(),
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => createdValues),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new AttributesService(prisma as never, audit as never);
    return { service, prisma, createdAttributes, createdValues, audit };
  }

  it('a fully custom attribute (arbitrary code) is created with its own values', async () => {
    const { service, createdAttributes, createdValues } = makeService();

    const attr = (await service.createAttribute(
      COMPANY,
      { code: 'capacite-batterie', nameFa: 'ظرفیت باتری', nameEn: 'Battery capacity' },
      actor,
      {},
    )) as { id: string; code: string };
    expect(createdAttributes[0]).toMatchObject({ code: 'capacite-batterie' });

    const v1 = (await service.createValue(
      COMPANY,
      attr.id,
      { attributeId: attr.id, code: '4000mah', valueFa: '۴۰۰۰ میلی‌آمپر', numericValue: '4000' },
      actor,
      {},
    )) as { code: string };
    const v2 = (await service.createValue(
      COMPANY,
      attr.id,
      { attributeId: attr.id, code: '5000mah', valueFa: '۵۰۰۰ میلی‌آمپر', numericValue: '5000' },
      actor,
      {},
    )) as { code: string };

    expect(createdValues).toHaveLength(2);
    expect(createdValues.every((v) => v.attributeId === attr.id)).toBe(true);
    expect(v1.code).toBe('4000mah');
    expect(v2.code).toBe('5000mah');
  });

  it('listing the attribute returns its values (nothing pre-seeded — no hard-coded catalog)', async () => {
    const { service, createdAttributes, createdValues } = makeService();
    expect(createdAttributes).toHaveLength(0);
    expect(createdValues).toHaveLength(0);

    const attr = (await service.createAttribute(
      COMPANY,
      { code: 'رنگ-joint', nameFa: 'رنگ' },
      actor,
      {},
    )) as { id: string };
    await service.createValue(COMPANY, attr.id, { attributeId: attr.id, code: 'red', valueFa: 'قرمز' }, actor, {});

    const list = (await service.listAttributes(COMPANY, {})) as {
      items: Array<{ id: string; values: unknown[] }>;
    };
    expect(list.items.find((a) => a.id === attr.id)).toBeDefined();

    const values = (await service.listValues(COMPANY, attr.id)) as unknown[];
    expect(values).toHaveLength(1);
  });
});
