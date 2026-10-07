import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, dailyPriceService, createVariantInCompany } from '../testing/p5-fixtures';
import { dayFromKey, todayKey } from './day';

/**
 * p5-01 price-upsert-audit: creating today's price audits CREATE; updating
 * TODAY's row audits PRICE_CHANGED with OLD/NEW values; the unique
 * (company, variant, date, uom) keeps exactly ONE row per key.
 */
describeIntegration('p5-01 price-upsert-audit', () => {
  const prisma = integrationPrisma();
  const marker = `p5-01-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let uomCategoryId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
  });

  it('creating today\'s price audits CREATE and updating audits PRICE_CHANGED old/new', async () => {
    const service = dailyPriceService(prisma);
    const today = todayKey();
    const actor = { id: actorId, username: 'admin' };

    const created = await service.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 34250, notes: 'اولیه' },
      actor,
      {},
    );
    expect(Number(created.price)).toBe(34250);

    const createAudit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'daily_price', entityId: created.id, action: 'CREATE' },
    });
    expect(createAudit.companyId).toBe(INTEGRATION_COMPANY_ID);

    // Update TODAY: same row (unique key), audited with old/new.
    const updated = await service.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 35000, notes: 'اصلاح' },
      actor,
      {},
    );
    expect(updated.id).toBe(created.id);
    expect(Number(updated.price)).toBe(35000);
    expect(updated.version).toBe(created.version + 1);

    const changeAudit = await prisma.auditLog.findFirstOrThrow({
      where: { entityType: 'daily_price', entityId: created.id, action: 'PRICE_CHANGED' },
      orderBy: { createdAt: 'desc' as const },
    });
    expect(Number((changeAudit.oldValues as { price: string }).price)).toBe(34250);
    expect(Number((changeAudit.newValues as { price: string }).price)).toBe(35000);
    expect((changeAudit.oldValues as { notes: string | null }).notes).toBe('اولیه');
    expect((changeAudit.newValues as { notes: string | null }).notes).toBe('اصلاح');
  });

  it('exactly ONE row per (company, variant, date, uom) after repeated upserts', async () => {
    const rows = await prisma.dailyPrice.findMany({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        productVariantId: variantId,
        uomId,
        date: dayFromKey(todayKey()),
      },
    });
    expect(rows).toHaveLength(1);
  });

  afterAll(async () => {
    await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.variantAttributeValue.deleteMany({ where: { variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.uom.deleteMany({ where: { id: uomId } });
    if (uomCategoryId) await prisma.uomCategory.deleteMany({ where: { id: uomCategoryId } });
    await disconnectIntegrationPrisma();
  });
});
