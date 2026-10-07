import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  dailyPriceService,
  createVariantInCompany,
  priceRequestServiceWithPricing,
} from '../testing/p5-fixtures';
import { DailyPriceTodayPriceProvider } from './daily-price-today.provider';
import { NullTodayPriceProvider } from '../price-request/today-price.provider';
import { todayKey } from './day';

/**
 * p5-04 today-price-provider: with the Phase 5 DailyPriceTodayPriceProvider
 * bound to TODAY_PRICE_PROVIDER, a price-request line shows the REAL daily
 * price (source `daily_price`); the Phase 4 NullTodayPriceProvider keeps
 * returning null (kept for tests / pricing-less deployments).
 */
describeIntegration('p5-04 today-price-provider', () => {
  const prisma = integrationPrisma();
  const marker = `p5-04-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let requestId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
  });

  it('the provider returns the real daily price; requests lines carry it', async () => {
    // Enter today's price first.
    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: todayKey(), uomId, price: 34250 },
      { id: actorId, username: 'admin' },
      {},
    );

    const provider = new DailyPriceTodayPriceProvider(prisma as never);
    const price = await provider.getTodayPrice(INTEGRATION_COMPANY_ID, variantId, uomId);
    expect(price).not.toBeNull();
    expect(Number(price!.price)).toBe(34250);
    expect(price!.source).toBe('daily_price');

    // Price request flow with the provider bound → line shows today's price.
    const service = priceRequestServiceWithPricing(prisma);
    const request = await service.create(
      INTEGRATION_COMPANY_ID,
      { lines: [{ productVariantId: variantId, requestedQuantity: 2 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    requestId = request.id;
    const detail = await service.getById(INTEGRATION_COMPANY_ID, request.id);
    expect(detail.lines).toHaveLength(1);
    expect(Number(detail.lines[0].todayPrice!.price)).toBe(34250);
    expect(detail.lines[0].todayPrice!.source).toBe('daily_price');
  });

  it('the NullTodayPriceProvider (Phase 4 default, kept for tests) still returns null', async () => {
    const provider = new NullTodayPriceProvider();
    expect(await provider.getTodayPrice()).toBeNull();
  });

  afterAll(async () => {
    if (requestId) await prisma.priceRequest.deleteMany({ where: { id: requestId } });
    await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.uom.deleteMany({ where: { id: uomId } });
    await disconnectIntegrationPrisma();
  });
});
