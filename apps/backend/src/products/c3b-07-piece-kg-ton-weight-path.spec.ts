import { UomConversionService } from './uom-conversion.service';

/**
 * c3b-07 — piece-kg-ton through convertWithProductWeight: a variant of
 * 18.7 kg/piece converts 100 pieces → 1870 kg and → 1.87 ton (quantity ×
 * weightPerUnit, then the standard Weight-category conversion to the
 * target). Without the weight UOM the cross-category path stays blocked.
 */
describe('c3b-07 piece-kg-ton-weight-path', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const CAT_UNIT = 'cat-unit';
  const CAT_WEIGHT = 'cat-weight';

  const PCS = { id: 'u-pcs', companyId: COMPANY, categoryId: CAT_UNIT, symbol: 'pcs', conversionRatio: '1' };
  const KG = { id: 'u-kg', companyId: COMPANY, categoryId: CAT_WEIGHT, symbol: 'kg', conversionRatio: '1' };
  const TON = { id: 'u-ton', companyId: COMPANY, categoryId: CAT_WEIGHT, symbol: 'ton', conversionRatio: '1000' };

  function makePrisma() {
    return {
      uom: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          switch (args.where.id) {
            case PCS.id: return PCS;
            case KG.id: return KG;
            case TON.id: return TON;
            default: return null;
          }
        }),
        findFirst: jest.fn(async () => ({ id: 'base-1', symbol: 'base' })),
      },
    };
  }

  it('100 pieces × 18.7 kg/piece → 1870 kg (Decimal exact)', async () => {
    const service = new UomConversionService(makePrisma() as never);
    const result = await service.convertWithProductWeight(
      '100', PCS.id, KG.id, { weightPerUnit: '18.7', weightUomId: KG.id }, COMPANY,
    );
    expect(result.value.toString()).toBe('1870');
    expect(result.fromSymbol).toBe('pcs');
    expect(result.toSymbol).toBe('kg');
    expect(result.categoryId).toBe(CAT_WEIGHT);
  });

  it('…and one step further: 1870 kg → 1.87 ton', async () => {
    const service = new UomConversionService(makePrisma() as never);
    const result = await service.convertWithProductWeight(
      '100', PCS.id, TON.id, { weightPerUnit: '18.7', weightUomId: KG.id }, COMPANY,
    );
    expect(result.value.toString()).toBe('1.87');
    expect(result.toSymbol).toBe('ton');
  });

  it('the inverse direction: 1 ton → 1000 kg stays same-category', async () => {
    const service = new UomConversionService(makePrisma() as never);
    const result = await service.convert('1', TON.id, KG.id);
    expect(result.value.toString()).toBe('1000');
  });

  it('weightPerUnit WITHOUT weightUomId → no weight path: piece→kg stays blocked', async () => {
    const service = new UomConversionService(makePrisma() as never);
    await expect(
      service.convertWithProductWeight('100', PCS.id, KG.id, { weightPerUnit: '18.7', weightUomId: null }),
    ).rejects.toMatchObject({ message: 'UOM_CATEGORY_MISMATCH' });
    await expect(
      service.convertWithProductWeight('100', PCS.id, KG.id, null),
    ).rejects.toMatchObject({ message: 'UOM_CATEGORY_MISMATCH' });
  });

  it('a conversion inside a category WITHOUT any active base unit is blocked (UOM_NO_BASE_UNIT)', async () => {
    const prisma = makePrisma();
    (prisma.uom.findFirst as jest.Mock).mockResolvedValue(null);
    const service = new UomConversionService(prisma as never);
    await expect(service.convert('1', TON.id, KG.id)).rejects.toMatchObject({
      message: 'UOM_NO_BASE_UNIT',
    });
  });

  it('a UOM of ANOTHER company is rejected when the company context is given', async () => {
    const service = new UomConversionService(makePrisma() as never);
    await expect(service.convert('1', TON.id, KG.id, 'company-OTHER')).rejects.toMatchObject({
      message: 'UOM_NOT_IN_COMPANY',
    });
  });
});
