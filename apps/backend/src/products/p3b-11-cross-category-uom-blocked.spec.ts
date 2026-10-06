import { applyConversion, UomConversionService } from './uom-conversion.service';

/**
 * p3b-11 — cross-category-uom-blocked: converting between UOMs of different
 * categories (kg → meter) is rejected with ValidationError
 * `UOM_CATEGORY_MISMATCH`, both in the pure rule and the DB-backed path.
 */
describe('p3b-11 cross-category-uom-blocked', () => {
  const KG = { id: 'u-kg', categoryId: 'cat-weight', symbol: 'kg', conversionRatio: '1' };
  const METER = { id: 'u-m', categoryId: 'cat-length', symbol: 'm', conversionRatio: '1' };

  it('pure rule: kg → meter throws UOM_CATEGORY_MISMATCH', () => {
    expect(() => applyConversion(KG, METER, '2500')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_ERROR', message: 'UOM_CATEGORY_MISMATCH' }),
    );
  });

  it('meter → kg is blocked in the other direction too', () => {
    expect(() => applyConversion(METER, KG, '3')).toThrow(
      expect.objectContaining({ message: 'UOM_CATEGORY_MISMATCH' }),
    );
  });

  it('the DB-backed path loads both UOMs and still blocks cross-category', async () => {
    const prisma = {
      uom: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (args.where.id === KG.id) return KG;
          if (args.where.id === METER.id) return METER;
          return null;
        }),
        findFirst: jest.fn(async () => ({ id: 'u-base', symbol: 'kg' })),
      },
    };
    const service = new UomConversionService(prisma as never);
    await expect(service.convert('2500', KG.id, METER.id)).rejects.toMatchObject({
      message: 'UOM_CATEGORY_MISMATCH',
      details: {
        fromCategoryId: 'cat-weight',
        toCategoryId: 'cat-length',
      },
    });
  });
});
