import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, dailyPriceService } from '../testing/p5-fixtures';
import { computeBulkPrice } from './daily-price.service';
import { dayFromKey, todayKey } from './day';
import { Prisma } from '@prisma/client';

/**
 * p5-03 bulk-update: percent up/down over a category filter with EXACT
 * Decimal math (no float drift); per-row audits + one BULK_PRICE_UPDATE
 * summary audit.
 */
describeIntegration('p5-03 bulk-update', () => {
  const prisma = integrationPrisma();
  const marker = `p5-03-${Date.now()}`;
  let actorId = '';
  let companyId = INTEGRATION_COMPANY_ID;
  let categoryId = '';
  let templateId = '';
  let uomId = '';
  const variantIds: string[] = [];

  async function makeVariant(sku: string) {
    const variant = await prisma.productVariant.create({
      data: {
        companyId,
        templateId,
        sku: `P5-03-${sku}`,
        nameFa: `وارینت ${sku}`,
        combinationKey: `p5-03=${sku}`,
        defaultUomId: uomId,
      },
    });
    variantIds.push(variant.id);
    return variant.id;
  }

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const category = await prisma.productCategory.create({
      data: { companyId, code: `P5-03-CAT-${marker}`, nameFa: 'دسته بولک' },
    });
    categoryId = category.id;
    const uomCategory = await prisma.uomCategory.create({
      data: { companyId, code: `P5-03-W-${marker}`, nameFa: 'وزن' },
    });
    const uom = await prisma.uom.create({
      data: {
        companyId,
        categoryId: uomCategory.id,
        symbol: `kg-${marker}`,
        nameFa: 'کیلوگرم',
        conversionRatio: '1',
        isBaseUnit: true,
      },
    });
    uomId = uom.id;
    const template = await prisma.productTemplate.create({
      data: {
        companyId,
        categoryId,
        nameFa: `قالب ${marker}`,
        defaultSalesUomId: uom.id,
        defaultSalesPrice: '500',
      },
    });
    templateId = template.id;
    await makeVariant('A');
    await makeVariant('B');
    await makeVariant('C'); // no price row yet → base = template default 500
  });

  it('pure helper: exact Decimal math for all four modes', () => {
    const D = (v: string) => new Prisma.Decimal(v);
    expect(computeBulkPrice('PERCENT_UP', D('10'), D('1000')).toString()).toBe('1100');
    expect(computeBulkPrice('PERCENT_DOWN', D('12.5'), D('800')).toString()).toBe('700');
    expect(computeBulkPrice('FIXED_UP', D('37.25'), D('100')).toString()).toBe('137.25');
    expect(computeBulkPrice('FIXED_DOWN', D('37.25'), D('100')).toString()).toBe('62.75');
  });

  it('PERCENT_UP 10% over the category → exact 1100/880/550', async () => {
    const service = dailyPriceService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const today = todayKey();

    // Seed today's rows: A=1000, B=800 (C intentionally absent).
    await service.upsert(companyId, { productVariantId: variantIds[0], date: today, uomId, price: 1000 }, actor, {});
    await service.upsert(companyId, { productVariantId: variantIds[1], date: today, uomId, price: 800 }, actor, {});

    const result = await service.bulkUpdate(
      companyId,
      { date: today, filter: { categoryId }, mode: 'PERCENT_UP', amount: 10 },
      actor,
      {},
    );
    expect(result.updated).toBe(3);
    expect(result.skipped).toBe(0);
    const byVariant = new Map(result.items.map((i) => [i.variantId, i] as const));
    expect(Number(byVariant.get(variantIds[0])!.price)).toBe(1100);
    expect(Number(byVariant.get(variantIds[1])!.price)).toBe(880);
    expect(Number(byVariant.get(variantIds[2])!.price)).toBe(550); // base = template default 500

    const rowA = await prisma.dailyPrice.findFirstOrThrow({
      where: { companyId, productVariantId: variantIds[0], date: dayFromKey(today) },
    });
    expect(rowA.price.toFixed(4)).toBe('1100.0000');

    // One summary audit for the whole bulk run.
    const summary = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'daily_price', action: 'BULK_PRICE_UPDATE', companyId },
      orderBy: { createdAt: 'desc' as const },
    });
    expect((summary.newValues as { updated: number }).updated).toBe(3);
    expect((summary.newValues as { mode: string }).mode).toBe('PERCENT_UP');
  });

  it('PERCENT_DOWN 12.5% keeps exact decimals (880 → 770)', async () => {
    const service = dailyPriceService(prisma);
    const result = await service.bulkUpdate(
      companyId,
      { date: todayKey(), filter: { categoryId }, mode: 'PERCENT_DOWN', amount: 12.5 },
      { id: actorId, username: 'admin' },
      {},
    );
    const byVariant = new Map(result.items.map((i) => [i.variantId, i] as const));
    expect(Number(byVariant.get(variantIds[0])!.price)).toBe(962.5); // 1100 × 0.875
    expect(Number(byVariant.get(variantIds[1])!.price)).toBe(770); // 880 − 110
    expect(Number(byVariant.get(variantIds[2])!.price)).toBe(481.25); // 550 × 0.875

    // The stored DECIMAL(20,4) values keep the exact scale.
    const rowB = await prisma.dailyPrice.findFirstOrThrow({
      where: { companyId, productVariantId: variantIds[1], date: dayFromKey(todayKey()) },
    });
    expect(rowB.price.toFixed(4)).toBe('770.0000');
  });

  afterAll(async () => {
    await prisma.dailyPrice.deleteMany({ where: { companyId, productVariantId: { in: variantIds } } });
    await prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.uom.deleteMany({ where: { id: uomId } });
    await disconnectIntegrationPrisma();
  });
});
