import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariantInCompany, dailyPriceService } from '../testing/p5-fixtures';
import { cleanupPurchaseDocument, createParty, purchaseService } from '../testing/p4-fixtures';
import { storedDayKey, todayKey } from '../pricing/day';

/**
 * p5c-02 purchase line price-source wiring: purchase pricing is typically
 * MANUAL — an explicit unitPrice is MANUAL (priceDate null). Without an
 * explicit price, today's DailyPrice row for (variant, uom) is used as the
 * REFERENCE prefill (DAILY_PRICE + priceDate) — DailyPrice rows carry
 * whatever price was entered and the buyer stays free to change it. With
 * neither, the line stays 0 with no provenance (priceSource null).
 */
describeIntegration('p5c-02 purchase line price source', () => {
  const prisma = integrationPrisma();
  const marker = `p5c-02-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let templateId = '';
  let categoryId = '';
  let uomId = '';
  let noPriceVariantId = '';
  let noPriceTemplateId = '';
  let noPriceUomId = '';
  const docIds: string[] = [];
  const today = todayKey();
  const actor = () => ({ id: actorId, username: 'admin' });

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    supplierId = supplier.id;

    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
    uomId = fixture.uomId;

    const noPrice = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, `${marker}-np`);
    noPriceVariantId = noPrice.variantId;
    noPriceTemplateId = noPrice.templateId;
    noPriceUomId = noPrice.uomId;
  });

  it('an explicit unitPrice is MANUAL (default purchase behavior)', async () => {
    const doc = await purchaseService(prisma).create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplierId,
        lines: [{ productVariantId: variantId, quantity: 3, unitPrice: 25000 }],
      },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(Number(doc.lines[0].unitPrice)).toBe(25000);
    expect(doc.lines[0].priceSource).toBe('MANUAL');
    expect(doc.lines[0].priceDate).toBeNull();
  });

  it('no explicit price + a daily row → DAILY_PRICE reference prefill', async () => {
    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 20000 },
      actor(),
      {},
    );
    const doc = await purchaseService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 2 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(Number(doc.lines[0].unitPrice)).toBe(20000);
    expect(doc.lines[0].priceSource).toBe('DAILY_PRICE');
    expect(doc.lines[0].priceDate).not.toBeNull();
    expect(storedDayKey(doc.lines[0].priceDate as Date)).toBe(today);
    expect(Number(doc.lines[0].lineTotal)).toBe(40000);
  });

  it('no explicit price and no daily row → 0 with no provenance', async () => {
    const doc = await purchaseService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: noPriceVariantId, quantity: 1 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(Number(doc.lines[0].unitPrice)).toBe(0);
    expect(doc.lines[0].priceSource).toBeNull();
    expect(doc.lines[0].priceDate).toBeNull();
  });

  it('PATCHing the price marks MANUAL; a quantity-only edit keeps DAILY_PRICE', async () => {
    const service = purchaseService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 1 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);
    const line = doc.lines[0];
    expect(line.priceSource).toBe('DAILY_PRICE');

    const afterQuantity = await service.updateLine(
      INTEGRATION_COMPANY_ID,
      doc.id,
      line.id,
      { quantity: 7 },
      actor(),
      {},
    );
    expect(afterQuantity.lines[0].priceSource).toBe('DAILY_PRICE');
    expect(afterQuantity.lines[0].priceDate).not.toBeNull();

    const afterPrice = await service.updateLine(
      INTEGRATION_COMPANY_ID,
      doc.id,
      line.id,
      { unitPrice: 31000 },
      actor(),
      {},
    );
    expect(Number(afterPrice.lines[0].unitPrice)).toBe(31000);
    expect(afterPrice.lines[0].priceSource).toBe('MANUAL');
    expect(afterPrice.lines[0].priceDate).toBeNull();
  });

  afterAll(async () => {
    for (const id of docIds) await cleanupPurchaseDocument(prisma, id);
    await prisma.party.deleteMany({ where: { id: supplierId } });
    await prisma.dailyPrice.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: { in: [variantId, noPriceVariantId] } },
    });
    await prisma.productVariant.deleteMany({ where: { id: { in: [variantId, noPriceVariantId] } } });
    await prisma.productTemplate.deleteMany({ where: { id: { in: [templateId, noPriceTemplateId] } } });
    if (categoryId) await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    if (uomId) {
      await prisma.uom.deleteMany({ where: { id: { in: [uomId, noPriceUomId].filter(Boolean) } } });
      await prisma.uomCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { in: [`P5W-${marker}`, `P5W-${marker}-np`] } } });
    }
    await disconnectIntegrationPrisma();
  });
});
