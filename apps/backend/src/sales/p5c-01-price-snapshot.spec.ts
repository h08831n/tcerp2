import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariantInCompany, dailyPriceService } from '../testing/p5-fixtures';
import { cleanupSalesDocument, createParty, salesService } from '../testing/p4-fixtures';
import { storedDayKey, todayKey } from '../pricing/day';

/**
 * p5c-01 price snapshot (pricing-integrity review): a sales line created
 * WITHOUT an explicit unitPrice snapshots TODAY's DailyPrice for
 * (variant, uom) — priceSource=DAILY_PRICE, priceDate=today. Changing the
 * DailyPrice afterwards NEVER rewrites existing documents (the core
 * regression); a NEW document picks the new price. An explicit unitPrice is
 * MANUAL; no DailyPrice row falls back to the template default
 * (TEMPLATE_DEFAULT).
 */
describeIntegration('p5c-01 sales line price snapshot', () => {
  const prisma = integrationPrisma();
  const marker = `p5c-01-${Date.now()}`;
  let actorId = '';
  let customerId = '';
  let variantId = '';
  let templateId = '';
  let categoryId = '';
  let uomId = '';
  let fallbackVariantId = '';
  let fallbackTemplateId = '';
  let fallbackUomId = '';
  const docIds: string[] = [];
  const today = todayKey();
  const actor = () => ({ id: actorId, username: 'admin' });

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], marker);
    customerId = customer.id;

    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
    uomId = fixture.uomId;

    const fallback = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, `${marker}-fb`);
    fallbackVariantId = fallback.variantId;
    fallbackTemplateId = fallback.templateId;
    fallbackUomId = fallback.uomId;
    await prisma.productTemplate.update({
      where: { id: fallbackTemplateId },
      data: { defaultSalesPrice: '7777' },
    });
  });

  it('a line without an explicit price snapshots the DAILY_PRICE of today', async () => {
    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 31250 },
      actor(),
      {},
    );

    const doc = await salesService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customerId, lines: [{ productVariantId: variantId, quantity: 2 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);

    const line = doc.lines[0];
    expect(Number(line.unitPrice)).toBe(31250);
    expect(line.priceSource).toBe('DAILY_PRICE');
    expect(line.priceDate).not.toBeNull();
    expect(storedDayKey(line.priceDate as Date)).toBe(today);
    expect(Number(line.lineTotal)).toBe(62500);
  });

  it('changing the DailyPrice never rewrites the stored snapshot (core regression)', async () => {
    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 44000 },
      actor(),
      {},
    );

    const fetched = await salesService(prisma).getById(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, docIds[0]);
    expect(Number(fetched.lines[0].unitPrice)).toBe(31250); // STILL A
    expect(fetched.lines[0].priceSource).toBe('DAILY_PRICE');
  });

  it('a NEW quotation after the change picks the new daily price', async () => {
    const doc = await salesService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customerId, lines: [{ productVariantId: variantId, quantity: 1 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(Number(doc.lines[0].unitPrice)).toBe(44000);
    expect(doc.lines[0].priceSource).toBe('DAILY_PRICE');
  });

  it('an explicit unitPrice is MANUAL with a null priceDate', async () => {
    const doc = await salesService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      {
        customerPartyId: customerId,
        lines: [{ productVariantId: variantId, quantity: 1, unitPrice: 12345 }],
      },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(Number(doc.lines[0].unitPrice)).toBe(12345);
    expect(doc.lines[0].priceSource).toBe('MANUAL');
    expect(doc.lines[0].priceDate).toBeNull();
  });

  it('no DailyPrice row falls back to the template default (TEMPLATE_DEFAULT)', async () => {
    const doc = await salesService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customerId, lines: [{ productVariantId: fallbackVariantId, quantity: 1 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(Number(doc.lines[0].unitPrice)).toBe(7777);
    expect(doc.lines[0].priceSource).toBe('TEMPLATE_DEFAULT');
    expect(doc.lines[0].priceDate).toBeNull();
  });

  it('PATCHing unitPrice marks the line MANUAL; other edits keep the snapshot', async () => {
    const service = salesService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customerId, lines: [{ productVariantId: variantId, quantity: 1 }] },
      actor(),
      {},
    );
    docIds.push(doc.id);
    expect(doc.lines[0].priceSource).toBe('DAILY_PRICE');

    // A quantity-only edit must NOT rewrite the price provenance.
    const afterQuantity = await service.updateLine(
      INTEGRATION_COMPANY_ID,
      { actorScope: { userId: actorId, scope: 'ALL' }, teamUserIds: [], canOverrideConfirmedOrder: true },
      doc.id,
      doc.lines[0].id,
      { quantity: 5 },
      actor(),
      {},
    );
    expect(afterQuantity.lines[0].priceSource).toBe('DAILY_PRICE');
    expect(afterQuantity.lines[0].priceDate).not.toBeNull();

    // An explicit unitPrice change → MANUAL (confirmed-order override
    // semantics included).
    const afterPrice = await service.updateLine(
      INTEGRATION_COMPANY_ID,
      { actorScope: { userId: actorId, scope: 'ALL' }, teamUserIds: [], canOverrideConfirmedOrder: true },
      doc.id,
      doc.lines[0].id,
      { unitPrice: 9999 },
      actor(),
      {},
    );
    expect(Number(afterPrice.lines[0].unitPrice)).toBe(9999);
    expect(afterPrice.lines[0].priceSource).toBe('MANUAL');
    expect(afterPrice.lines[0].priceDate).toBeNull();
  });

  afterAll(async () => {
    for (const id of docIds) await cleanupSalesDocument(prisma, id);
    await prisma.party.deleteMany({ where: { id: customerId } });
    await prisma.dailyPrice.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: { in: [variantId, fallbackVariantId] } },
    });
    await prisma.productVariant.deleteMany({ where: { id: { in: [variantId, fallbackVariantId] } } });
    await prisma.productTemplate.deleteMany({ where: { id: { in: [templateId, fallbackTemplateId] } } });
    if (categoryId) await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    if (uomId) {
      await prisma.uom.deleteMany({ where: { id: { in: [uomId, fallbackUomId].filter(Boolean) } } });
      await prisma.uomCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { in: [`P5W-${marker}`, `P5W-${marker}-fb`] } } });
    }
    await disconnectIntegrationPrisma();
  });
});
