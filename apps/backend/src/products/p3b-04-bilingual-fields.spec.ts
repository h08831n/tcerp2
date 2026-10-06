import { CategoriesService } from './categories.service';
import { BrandsService } from './brands.service';
import { TemplatesService } from './templates.service';

/**
 * p3b-04 — bilingual-fields: categories, brands and templates store AND
 * return both nameFa and nameEn (and valueFa/valueEn for attribute values).
 */
describe('p3b-04 bilingual-fields', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'admin' };

  function txWith(capture: Record<string, unknown>[]) {
    return {
      productCategory: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: 'cat-1', version: 1, ...args.data };
          capture.push(row);
          return row;
        }),
      },
      brand: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: 'brand-1', version: 1, ...args.data };
          capture.push(row);
          return row;
        }),
      },
      productTemplate: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: 'tpl-1', version: 1, ...args.data };
          capture.push(row);
          return row;
        }),
      },
    };
  }

  function makePrisma(tx: Record<string, unknown>) {
    return {
      productCategory: {
        create: jest.fn(),
        findUnique: jest.fn(async () => null),
        findMany: jest.fn(async () => []),
      },
      brand: { create: jest.fn(), findUnique: jest.fn(async () => null) },
      fileAttachment: { findUnique: jest.fn(async () => null) },
      productTemplate: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
    };
  }

  it('category stores nameFa + nameEn and returns both', async () => {
    const capture: Record<string, unknown>[] = [];
    const tx = txWith(capture);
    const service = new CategoriesService(makePrisma(tx) as never, { recordTx: jest.fn() } as never);
    const row = (await service.create(
      COMPANY,
      { code: 'ELEC', nameFa: 'الکترونیک', nameEn: 'Electronics' },
      actor,
      {},
    )) as { nameFa: string; nameEn: string };

    expect(capture[0]).toMatchObject({ nameFa: 'الکترونیک', nameEn: 'Electronics' });
    expect(row.nameFa).toBe('الکترونیک');
    expect(row.nameEn).toBe('Electronics');
  });

  it('brand stores nameFa + nameEn and returns both', async () => {
    const capture: Record<string, unknown>[] = [];
    const tx = txWith(capture);
    const service = new BrandsService(makePrisma(tx) as never, { recordTx: jest.fn() } as never);
    const row = (await service.create(
      COMPANY,
      { code: 'SAMSUNG', nameFa: 'سامسونگ', nameEn: 'Samsung' },
      actor,
      {},
    )) as { nameFa: string; nameEn: string };

    expect(capture[0]).toMatchObject({ nameFa: 'سامسونگ', nameEn: 'Samsung' });
    expect(row.nameEn).toBe('Samsung');
  });

  it('template stores nameFa + nameEn and returns both', async () => {
    const capture: Record<string, unknown>[] = [];
    const tx = txWith(capture);
    const prisma = makePrisma(tx);
    (prisma.productCategory.findUnique as jest.Mock).mockResolvedValue({
      id: 'cat-1',
      companyId: COMPANY,
      active: true,
    });
    const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
    const row = (await service.create(
      COMPANY,
      { categoryId: 'cat-1', nameFa: 'گوشی A12', nameEn: 'Phone A12', internalCode: 'P-A12' },
      actor,
      {},
    )) as { nameFa: string; nameEn: string };

    expect(capture[0]).toMatchObject({ nameFa: 'گوشی A12', nameEn: 'Phone A12' });
    expect(row.nameEn).toBe('Phone A12');
  });
});
