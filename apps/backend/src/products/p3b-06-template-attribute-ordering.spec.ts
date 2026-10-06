import { TemplatesService } from './templates.service';

/**
 * p3b-06 — template-attribute-ordering: attributes attached to a template
 * are ordered by displayOrder in the template detail AND in the matrix /
 * variant-space queries (Phase 4 needs a stable column/row order).
 */
describe('p3b-06 template-attribute-ordering', () => {
  const COMPANY = 'company-1';

  function makePrisma() {
    return {
      productTemplate: { findUnique: jest.fn(async () => null) },
      productTemplateAttribute: { findMany: jest.fn(async () => []) },
      productVariant: { findMany: jest.fn(async () => []) },
    };
  }

  it('template detail orders attributes by displayOrder asc', async () => {
    const prisma = makePrisma();
    (prisma.productTemplate.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'tpl-1',
      companyId: COMPANY,
      attributes: [],
      variants: [],
    });
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    await service.getById(COMPANY, 'tpl-1');

    const args = (prisma.productTemplate.findUnique as jest.Mock).mock.calls[0][0];
    expect(args.include.attributes.orderBy).toEqual([
      { displayOrder: 'asc' },
      expect.anything(),
    ]);
    expect(args.include.attributes.include.attribute.include.values.orderBy).toEqual([
      { displayOrder: 'asc' },
      { valueFa: 'asc' },
    ]);
  });

  it('the variant space (matrix columns/rows, preview order) is displayOrder-ordered', async () => {
    const prisma = makePrisma();
    (prisma.productTemplate.findUnique as jest.Mock).mockResolvedValue({
      id: 'tpl-1',
      companyId: COMPANY,
      internalCode: 'P-1',
      nameFa: 'قالب',
      active: true,
    });
    (prisma.productTemplateAttribute.findMany as jest.Mock).mockResolvedValue([
      {
        attributeId: 'a1',
        attribute: { id: 'a1', code: 'A1', nameFa: 'ویژگی', values: [{ id: 'v1', code: 'V1', valueFa: 'یک' }] },
      },
    ]);
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    await service.matrix(COMPANY, 'tpl-1');
    await service.previewVariants(COMPANY, 'tpl-1', {
      selections: [{ attributeId: 'a1', valueIds: ['v1'] }],
    });

    const matrixArgs = (prisma.productTemplateAttribute.findMany as jest.Mock).mock.calls[0][0];
    expect(matrixArgs.where).toMatchObject({ templateId: 'tpl-1', createsVariants: true });
    expect(matrixArgs.orderBy[0]).toEqual({ displayOrder: 'asc' });

    const previewArgs = (prisma.productTemplateAttribute.findMany as jest.Mock).mock.calls[1][0];
    expect(previewArgs.orderBy[0]).toEqual({ displayOrder: 'asc' });
  });

  it('matrix maps space rows in the displayOrder sequence they arrive in', async () => {
    const prisma = makePrisma();
    (prisma.productTemplate.findUnique as jest.Mock).mockResolvedValue({
      id: 'tpl-1',
      companyId: COMPANY,
      internalCode: 'P-1',
      nameFa: 'قالب',
      active: true,
    });
    (prisma.productTemplateAttribute.findMany as jest.Mock).mockResolvedValue([
      {
        attributeId: 'a-color',
        attribute: {
          id: 'a-color',
          code: 'COLOR',
          nameFa: 'رنگ',
          values: [{ id: 'v-red', code: 'red', valueFa: 'قرمز' }],
        },
      },
      {
        attributeId: 'a-size',
        attribute: {
          id: 'a-size',
          code: 'SIZE',
          nameFa: 'سایز',
          values: [{ id: 'v-l', code: 'L', valueFa: 'بزرگ' }],
        },
      },
    ]);
    (prisma.productVariant.findMany as jest.Mock).mockResolvedValue([]);
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    const matrix = (await service.matrix(COMPANY, 'tpl-1')) as {
      columns: Array<{ attributeId: string }>;
      rows: Array<{ attributeId: string }>;
    };

    expect(matrix.columns.map((c) => c.attributeId)).toEqual(['a-color']);
    expect(matrix.rows.map((r) => r.attributeId)).toEqual(['a-size']);
  });
});
