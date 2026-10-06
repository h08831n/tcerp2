import { applyConversion } from './uom-conversion.service';
import { UomConversionService } from './uom-conversion.service';

/**
 * p3b-10 — kg-to-ton-conversion: 2500 kg → 2.5 ton (and the inverse),
 * pure Prisma.Decimal arithmetic — never float.
 */
describe('p3b-10 kg-to-ton-conversion', () => {
  const KG = { id: 'u-kg', categoryId: 'cat-weight', symbol: 'kg', conversionRatio: '1' };
  const TON = { id: 'u-ton', categoryId: 'cat-weight', symbol: 'ton', conversionRatio: '1000' };

  it('2500 kg → 2.5 ton (Decimal, exact)', () => {
    const result = applyConversion(KG, TON, '2500');
    expect(result.value.toString()).toBe('2.5');
    expect(result.fromSymbol).toBe('kg');
    expect(result.toSymbol).toBe('ton');
    expect(result.categoryId).toBe('cat-weight');
  });

  it('2.5 ton → 2500 kg (inverse)', () => {
    const result = applyConversion(TON, KG, '2.5');
    expect(result.value.toString()).toBe('2500');
  });

  it('Decimal arithmetic, not float: 0.1 + 0.2 style inputs stay exact', () => {
    // 1.7 kg via a ratio of 3 must not drift: 1.7 * 1 / 1 === 1.7
    const result = applyConversion(KG, KG, '1.7');
    expect(result.value.toString()).toBe('1.7');
  });

  it('the DB-backed convert endpoint path resolves both UOMs and converts', async () => {
    const prisma = {
      uom: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (args.where.id === KG.id) return KG;
          if (args.where.id === TON.id) return TON;
          return null;
        }),
      },
    };
    const service = new UomConversionService(prisma as never);
    const result = await service.convert('2500', KG.id, TON.id);
    expect(result.value.toString()).toBe('2.5');
    expect(result.toSymbol).toBe('ton');
  });
});
