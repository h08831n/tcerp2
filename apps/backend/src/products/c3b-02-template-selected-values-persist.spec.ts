import { TemplatesService } from './templates.service';

/**
 * c3b-02 — template-selected-values-persist: POST …/values {valueIds}
 * replaces the selected set (persisted with order as displayOrder, empty
 * array clears it), {valueId} adds a single value idempotently, and the
 * variant preview/matrix use ONLY the selected values as the value universe
 * for a template attribute that has selections (transitional fallback to the
 * attribute's global active values applies ONLY when no selection exists).
 */
describe('c3b-02 template-selected-values-persist', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const TEMPLATE = '11111111-1111-4111-8111-111111111111';
  const ATTR = '22222222-2222-4222-8222-222222222222';
  const V_RED = '33333333-3333-4333-8333-333333333333';
  const V_BLUE = '44444444-4444-4444-8444-444444444444';
  const V_GREEN = '55555555-5555-4555-8555-555555555555';

  const template = {
    id: TEMPLATE,
    companyId: COMPANY,
    internalCode: 'P-02',
    nameFa: 'قالب دو',
    active: true,
  };

  const valueMeta = (id: string, code: string) => ({ id, code, valueFa: code });

  // The attribute's global active values (RED, BLUE, GREEN); the template
  // SELECTED only RED + BLUE — GREEN stays out of the template's universe.
  const SPACE = [
    {
      id: 'pta-1',
      attributeId: ATTR,
      displayOrder: 1,
      createsVariants: true,
      attribute: {
        id: ATTR,
        code: 'COLOR',
        nameFa: 'رنگ',
        values: [valueMeta(V_RED, 'RED'), valueMeta(V_BLUE, 'BLUE'), valueMeta(V_GREEN, 'GREEN')],
      },
      selectedValues: [
        { id: 'sel-1', attributeValueId: V_RED, attributeValue: valueMeta(V_RED, 'RED') },
        { id: 'sel-2', attributeValueId: V_BLUE, attributeValue: valueMeta(V_BLUE, 'BLUE') },
      ],
    },
  ];

  // Same shape but with NO selections yet — transitional fallback universe.
  const SPACE_UNSELECTED = [
    { ...SPACE[0], selectedValues: [] },
  ];

  function makeService() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = {
      productTemplate: { findUnique: jest.fn(async () => template) },
      productTemplateAttribute: {
        findUnique: jest.fn(async () => SPACE[0]),
        findMany: jest.fn(async () => SPACE),
      },
      attributeValue: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          const meta = [V_RED, V_BLUE, V_GREEN].includes(args.where.id)
            ? valueMeta(args.where.id, args.where.id === V_RED ? 'RED' : args.where.id === V_BLUE ? 'BLUE' : 'GREEN')
            : null;
          return meta ? { id: meta.id, attributeId: ATTR, attribute: { companyId: COMPANY } } : null;
        }),
      },
      productTemplateAttributeValue: {
        findUnique: jest.fn(async () => null),
        findFirst: jest.fn(async () => ({ displayOrder: 0 })),
        findMany: jest.fn(async () => [
          { attributeValueId: V_BLUE, displayOrder: 0 },
          { attributeValueId: V_RED, displayOrder: 1 },
        ]),
        create: jest.fn(),
        createMany: jest.fn(async () => ({ count: 0 })),
        deleteMany: jest.fn(async () => ({ count: 0 })),
      },
      productVariant: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
    };
    const audit = { recordTx: jest.fn(), record: jest.fn() };
    return { service: new TemplatesService(prisma as never, audit as never), prisma, audit };
  }

  const actor = { id: 'u1', username: 'admin' };

  it('POST {valueIds} REPLACES the set, keeping request order as display order', async () => {
    const { service, prisma, audit } = makeService();
    const rows = (await service.setTemplateAttributeValues(
      COMPANY,
      TEMPLATE,
      ATTR,
      { valueIds: [V_BLUE, V_RED] },
      actor,
      {},
    )) as Array<{ attributeValueId: string }>;
    expect(prisma.productTemplateAttributeValue.deleteMany).toHaveBeenCalledWith({
      where: { templateAttributeId: 'pta-1' },
    });
    expect(prisma.productTemplateAttributeValue.createMany).toHaveBeenCalledWith({
      data: [
        { templateAttributeId: 'pta-1', attributeValueId: V_BLUE, displayOrder: 0 },
        { templateAttributeId: 'pta-1', attributeValueId: V_RED, displayOrder: 1 },
      ],
    });
    expect(rows.map((r) => r.attributeValueId)).toEqual([V_BLUE, V_RED]);
    // the swap + audit ran in one transaction
    expect(audit.recordTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entityType: 'product_template_attribute_value',
        action: 'UPDATE',
        oldValues: { templateId: TEMPLATE, attributeId: ATTR, valueIds: [V_BLUE, V_RED] },
        newValues: { templateId: TEMPLATE, attributeId: ATTR, valueIds: [V_BLUE, V_RED] },
      }),
    );
  });

  it('POST {valueIds: []} clears the selection (nothing recreated)', async () => {
    const { service, prisma } = makeService();
    await service.setTemplateAttributeValues(COMPANY, TEMPLATE, ATTR, { valueIds: [] }, actor, {});
    expect(prisma.productTemplateAttributeValue.deleteMany).toHaveBeenCalled();
    expect(prisma.productTemplateAttributeValue.createMany).not.toHaveBeenCalled();
  });

  it('POST {valueId} adds one value at max(displayOrder)+1 and is idempotent', async () => {
    const { service, prisma } = makeService();
    (prisma.productTemplateAttributeValue.create as jest.Mock).mockResolvedValue({
      id: 'sel-new',
      templateAttributeId: 'pta-1',
      attributeValueId: V_GREEN,
      displayOrder: 1,
      active: true,
    });
    const row = (await service.setTemplateAttributeValues(
      COMPANY,
      TEMPLATE,
      ATTR,
      { valueId: V_GREEN },
      actor,
      {},
    )) as { id: string };
    expect(row.id).toBe('sel-new');
    expect(prisma.productTemplateAttributeValue.create).toHaveBeenCalledWith({
      data: { templateAttributeId: 'pta-1', attributeValueId: V_GREEN, displayOrder: 1 },
    });

    const { service: s2, prisma: p2 } = makeService();
    (p2.productTemplateAttributeValue.findUnique as jest.Mock).mockResolvedValue({
      id: 'sel-1',
      attributeValueId: V_RED,
      displayOrder: 0,
    });
    const existing = (await s2.setTemplateAttributeValues(
      COMPANY,
      TEMPLATE,
      ATTR,
      { valueId: V_RED },
      actor,
      {},
    )) as { id: string };
    expect(existing.id).toBe('sel-1'); // existing row returned, no second insert
    expect(p2.productTemplateAttributeValue.create).not.toHaveBeenCalled();
  });

  it('preview builds combinations ONLY from the SELECTED values', async () => {
    const { service } = makeService();
    const result = (await service.previewVariants(COMPANY, TEMPLATE, {
      selections: [{ attributeId: ATTR, valueIds: [V_RED, V_BLUE] }],
    })) as { combinations: Array<{ combination: Array<{ valueId: string }> }> };
    expect(result.combinations).toHaveLength(2);
    expect(result.combinations.map((c) => c.combination[0].valueId).sort()).toEqual(
      [V_BLUE, V_RED].sort(),
    );
  });

  it('preview REJECTS a global attribute value that is not selected (VALUE_NOT_AVAILABLE_FOR_TEMPLATE)', async () => {
    const { service } = makeService();
    await expect(
      service.previewVariants(COMPANY, TEMPLATE, {
        selections: [{ attributeId: ATTR, valueIds: [V_GREEN] }],
      }),
    ).rejects.toMatchObject({ message: 'VALUE_NOT_AVAILABLE_FOR_TEMPLATE', details: { valueId: V_GREEN } });
  });

  it('transitional fallback: with NO selection yet the global active values are the universe', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = makeService().prisma;
    prisma.productTemplateAttribute.findMany = jest.fn(async () => SPACE_UNSELECTED);
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    const result = (await service.previewVariants(COMPANY, TEMPLATE, {
      selections: [{ attributeId: ATTR, valueIds: [V_RED, V_BLUE, V_GREEN] }],
    })) as { combinations: unknown[] };
    expect(result.combinations).toHaveLength(3);
  });

  it('matrix column/row values come from the selected universe only', async () => {
    const { service } = makeService();
    const result = (await service.matrix(COMPANY, TEMPLATE)) as {
      columns: Array<{ values: Array<{ id: string }> }>;
      rows: unknown[];
    };
    expect(result.columns[0].values.map((v) => v.id).sort()).toEqual([V_BLUE, V_RED].sort());
    expect(result.rows).toHaveLength(0); // single variant attribute → no rows
  });
});
