import { TemplatesService } from './templates.service';

/**
 * p3b-15 — product-list-no-n1: the templates list page resolves the whole
 * projection in at most 3 queries (findMany + count + ONE grouped variants
 * count) — no per-row follow-ups, the corr-02 pattern.
 */
describe('p3b-15 product-list-no-n1', () => {
  const COMPANY = 'company-1';

  function makePrisma(rows: Record<string, unknown>[]) {
    const calls: string[] = [];
    const prisma = {
      productTemplate: {
        findMany: jest.fn(async () => {
          calls.push('productTemplate.findMany');
          // The projection (category, brand) MUST be selected in the SAME
          // query — no N+1 follow-ups.
          return rows;
        }),
        count: jest.fn(async () => {
          calls.push('productTemplate.count');
          return rows.length;
        }),
      },
      productVariant: {
        groupBy: jest.fn(async () => {
          calls.push('productVariant.groupBy');
          return [{ templateId: 'tpl-1', _count: { _all: 4 } }];
        }),
      },
    };
    return { prisma, calls };
  }

  it('one page of templates costs exactly 3 queries', async () => {
    const { prisma, calls } = makePrisma([
      { id: 'tpl-1', nameFa: 'گوشی', nameEn: null, internalCode: 'P-1', category: { id: 'c1', nameFa: 'دسته' }, brand: null, productType: 'STORABLE', active: true, version: 1, createdAt: new Date() },
      { id: 'tpl-2', nameFa: 'لپ‌تاپ', nameEn: 'Laptop', internalCode: 'P-2', category: { id: 'c1', nameFa: 'دسته' }, brand: { id: 'b1', nameFa: 'برند' }, productType: 'STORABLE', active: true, version: 1, createdAt: new Date() },
    ]);
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    const page = (await service.list(COMPANY, { page: 1, pageSize: 20 } as never)) as {
      items: Array<{ id: string; variantsCount: number }>;
      total: number;
    };

    expect(calls).toHaveLength(3);
    expect(calls).toEqual(['productTemplate.findMany', 'productTemplate.count', 'productVariant.groupBy']);
    expect(page.items).toHaveLength(2);
    expect(page.items[0].variantsCount).toBe(4);
    expect(page.items[1].variantsCount).toBe(0);
  });

  it('the projection is lightweight (no full-row select, no nested variants/attributes)', async () => {
    const { prisma } = makePrisma([]);
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    await service.list(COMPANY, { page: 1, pageSize: 20 } as never);

    const args = (prisma.productTemplate.findMany as jest.Mock).mock.calls[0][0];
    expect(args.select).toMatchObject({
      id: true,
      nameFa: true,
      nameEn: true,
      internalCode: true,
      category: { select: { id: true, nameFa: true } },
      brand: { select: { id: true, nameFa: true } },
      productType: true,
      active: true,
      version: true,
      createdAt: true,
    });
    expect(args.select.variants).toBeUndefined();
    expect(args.select.attributes).toBeUndefined();
  });

  it('search filters nameFa/nameEn/internalCode in the SAME where clause', async () => {
    const { prisma } = makePrisma([]);
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    await service.list(COMPANY, { page: 1, pageSize: 20, search: 'گوشی' } as never);

    const args = (prisma.productTemplate.findMany as jest.Mock).mock.calls[0][0];
    expect(args.where.OR).toBeDefined();
    // where clauses of findMany and count must be consistent (same shape)
    const countArgs = (prisma.productTemplate.count as jest.Mock).mock.calls[0][0];
    expect(countArgs.where.OR).toBeDefined();
  });
});
