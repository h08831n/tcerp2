import { UomConversionService } from './uom-conversion.service';

/**
 * p3b-12 — product-weight-conversion (3B correction #3 contract): with the
 * variant carrying weightPerUnit = 18.7 AND its weightUomId (kg), 100 pieces
 * → 1870 kg via the explicit product-specific path
 * (convertWithProductWeight). WITHOUT a complete weight pair, a
 * cross-category conversion stays blocked (UOM_CATEGORY_MISMATCH).
 */
describe('p3b-12 product-weight-conversion', () => {
  const PIECE = { id: 'u-piece', categoryId: 'cat-count', symbol: 'pcs', conversionRatio: '1' };
  const KG = { id: 'u-kg', categoryId: 'cat-weight', symbol: 'kg', conversionRatio: '1' };

  function makePrisma() {
    return {
      uom: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (args.where.id === PIECE.id) return PIECE;
          if (args.where.id === KG.id) return KG;
          return null;
        }),
        findFirst: jest.fn(async () => ({ id: 'u-base', symbol: 'kg' })),
      },
    };
  }

  it('100 pieces × 18.7 kg = 1870 kg (Decimal exact)', async () => {
    const service = new UomConversionService(makePrisma() as never);
    const result = await service.convertWithProductWeight('100', PIECE.id, KG.id, {
      weightPerUnit: '18.7',
      weightUomId: KG.id,
    });
    expect(result.value.toString()).toBe('1870');
    expect(result.fromSymbol).toBe('pcs');
    expect(result.toSymbol).toBe('kg');
  });

  it('without a complete weight pair the cross-category conversion stays blocked', async () => {
    const service = new UomConversionService(makePrisma() as never);
    await expect(
      service.convertWithProductWeight('100', PIECE.id, KG.id, {
        weightPerUnit: null,
        weightUomId: KG.id,
      }),
    ).rejects.toMatchObject({ message: 'UOM_CATEGORY_MISMATCH' });
    await expect(
      service.convertWithProductWeight('100', PIECE.id, KG.id, null),
    ).rejects.toMatchObject({ message: 'UOM_CATEGORY_MISMATCH' });
  });

  it('with the weight pair set, cross-category is allowed (that is the point)', async () => {
    const service = new UomConversionService(makePrisma() as never);
    const result = await service.convertWithProductWeight('0.5', PIECE.id, KG.id, {
      weightPerUnit: '18.7',
      weightUomId: KG.id,
    });
    expect(result.value.toString()).toBe('9.35');
  });
});
