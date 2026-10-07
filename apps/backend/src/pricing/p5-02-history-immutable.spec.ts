import { ForbiddenError } from '../common/errors';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, dailyPriceService, createVariantInCompany } from '../testing/p5-fixtures';
import { shiftDayKey, todayKey } from './day';

/**
 * p5-02 history-immutable: PAST daily prices are immutable —
 * ForbiddenError('PRICE_HISTORY_IMMUTABLE') without pricing.edit_history;
 * with it the edit is allowed AND audited (PRICE_CHANGED, historyEdit flag).
 */
describeIntegration('p5-02 history-immutable', () => {
  const prisma = integrationPrisma();
  const marker = `p5-02-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  const yesterday = shiftDayKey(todayKey(), -1);

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
  });

  it('editing a past day without pricing.edit_history → PRICE_HISTORY_IMMUTABLE (update)', async () => {
    const service = dailyPriceService(prisma);
    const actor = { id: actorId, username: 'admin' };

    // Seed a past row WITH the special permission.
    await service.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: yesterday, uomId, price: 30000 },
      actor,
      {},
      { allowHistoryEdit: true },
    );

    await expect(
      service.upsert(
        INTEGRATION_COMPANY_ID,
        { productVariantId: variantId, date: yesterday, uomId, price: 31000 },
        actor,
        {},
        { allowHistoryEdit: false },
      ),
    ).rejects.toMatchObject({ message: 'PRICE_HISTORY_IMMUTABLE', statusCode: 403 });

    await expect(
      service.upsert(
        INTEGRATION_COMPANY_ID,
        { productVariantId: variantId, date: yesterday, uomId, price: 31000 },
        actor,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);

    // The row is untouched.
    const row = await prisma.dailyPrice.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId },
    });
    expect(Number(row.price)).toBe(30000);
  });

  it('creating a past day without the permission is blocked as well', async () => {
    const service = dailyPriceService(prisma);
    const before = await prisma.dailyPrice.count({
      where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId },
    });
    await expect(
      service.upsert(
        INTEGRATION_COMPANY_ID,
        { productVariantId: variantId, date: shiftDayKey(todayKey(), -2), uomId, price: 20000 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'PRICE_HISTORY_IMMUTABLE' });
    const after = await prisma.dailyPrice.count({
      where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId },
    });
    expect(after).toBe(before);
  });

  it('with pricing.edit_history the past edit is allowed AND audited', async () => {
    const service = dailyPriceService(prisma);
    const updated = await service.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: yesterday, uomId, price: 31500 },
      { id: actorId, username: 'admin' },
      {},
      { allowHistoryEdit: true },
    );
    expect(Number(updated.price)).toBe(31500);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'daily_price', entityId: updated.id, action: 'PRICE_CHANGED' },
      orderBy: { createdAt: 'desc' as const },
    });
    expect(Number((audit.oldValues as { price: string }).price)).toBe(30000);
    expect(Number((audit.newValues as { price: string }).price)).toBe(31500);
    expect((audit.oldValues as { historyEdit?: boolean }).historyEdit).toBe(true);
  });

  afterAll(async () => {
    await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.uom.deleteMany({ where: { id: uomId } });
    await disconnectIntegrationPrisma();
  });
});
