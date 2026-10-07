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
  createParty,
  publishingService,
  publishItemHandler,
  makeAdapters,
  publicApiService,
} from '../testing/p5-fixtures';
import { UnauthorizedError } from '../common/errors';
import { todayKey, shiftDayKey } from '../pricing/day';

/**
 * p5-14 website-public-api: public prices + history + portal lookup.
 * The lookup answers ONLY {matched, linked} (no customer data leak) and
 * mobile normalization accepts 09…/+98…/Persian digits as the same phone.
 * Also covers the `publicapi.website_only_published` filter and the
 * `publicapi.key` placeholder auth.
 */
describeIntegration('p5-14 website-public-api', () => {
  const prisma = integrationPrisma();
  const marker = `p5-14-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let partyId = '';
  let phoneId = '';
  let portalAccountId = '';
  let templateRowId = '';
  let configId = '';
  let batchId = '';
  const adapters = makeAdapters();
  const actor = () => ({ id: actorId, username: 'admin' });
  const today = todayKey();

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;

    const service = dailyPriceService(prisma);
    await service.upsert(INTEGRATION_COMPANY_ID, { productVariantId: variantId, date: today, uomId, price: 31250 }, actor(), {});
    // Yesterday needs pricing.edit_history (history is immutable).
    await service.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: shiftDayKey(today, -1), uomId, price: 30800 },
      actor(),
      {},
      { allowHistoryEdit: true },
    );
  });

  it('public prices return the day\'s rows with catalog join (no auth, company-scoped)', async () => {
    const api = publicApiService(prisma);
    const companyId = await api.resolveCompanyId({ companyId: INTEGRATION_COMPANY_ID });
    expect(companyId).toBe(INTEGRATION_COMPANY_ID);

    const result = await api.prices(companyId, { date: today });
    const item = result.items.find((i: { variantId: string }) => i.variantId === variantId)!;
    expect(Number(item.price)).toBe(31250);
    expect(item.sku).toBe(`P5-${marker}`);
    expect(item.uom).toContain('kg-');
    expect(item.lastUpdatedAt).toBeDefined();
  });

  it('price history returns the last N days newest-first', async () => {
    const api = publicApiService(prisma);
    const result = await api.priceHistory(INTEGRATION_COMPANY_ID, variantId, 2);
    expect(result.items).toHaveLength(2);
    expect(result.items[0].date).toBe(today);
    expect(Number(result.items[0].price)).toBe(31250);
    expect(result.items[1].date).toBe(shiftDayKey(today, -1));
  });

  it('portal lookup: {matched, linked} ONLY — mobile normalization 09…/+98…', async () => {
    const party = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    partyId = party.id;
    // Unique per-company mobile (the partial unique index blocks duplicates).
    const mobile = `0912${String(Date.now()).slice(-7)}`;
    const phone = await prisma.partyPhone.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        partyId,
        kind: 'MOBILE',
        rawValue: mobile,
        normalizedValue: mobile,
        isPrimary: true,
      },
    });
    phoneId = phone.id;
    const account = await prisma.portalAccount.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        partyId,
        verifiedMobile: mobile,
        status: 'ACTIVE',
      },
    });
    portalAccountId = account.id;

    const api = publicApiService(prisma);
    // Persian-digit rendering of the same mobile (§75 normalization).
    const persian = mobile.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
    // All of these normalize to the same canonical mobile:
    for (const input of [mobile, `+98${mobile.slice(1)}`, `0098${mobile.slice(1)}`, `${mobile.slice(0, 4)} ${mobile.slice(4, 7)} ${mobile.slice(7)}`, persian]) {
      const result = await api.portalLookup(INTEGRATION_COMPANY_ID, input);
      expect(result).toEqual({ matched: true, linked: true });
    }
    // Exactly {matched, linked} — nothing else is exposed (§75).
    const keys = Object.keys(await api.portalLookup(INTEGRATION_COMPANY_ID, mobile)).sort();
    expect(keys).toEqual(['linked', 'matched']);

    const unknown = await api.portalLookup(INTEGRATION_COMPANY_ID, '09350000000');
    expect(unknown).toEqual({ matched: false, linked: false });
  });

  it('invalid mobiles are rejected as validation errors', async () => {
    const api = publicApiService(prisma);
    await expect(api.portalLookup(INTEGRATION_COMPANY_ID, '12345')).rejects.toBeInstanceOf(Error);
  });

  it('publicapi.website_only_published=true restricts to SUCCESS WEBSITE items', async () => {
    await prisma.setting.create({
      data: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.website_only_published', value: true, category: 'publicapi' },
    });

    const api = publicApiService(prisma);
    let result = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    expect(result.items).toEqual([]); // nothing published yet

    // Publish to WEBSITE through the real engine (mock adapter).
    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5-14-web-${marker}`,
        name: 'Website mock',
        type: 'WEBSITE',
        isActive: true,
        config: { mode: 'mock' },
      },
    });
    configId = config.id;
    const template = await prisma.publishingTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        channel: 'WEBSITE',
        code: `P5-14-${marker}`,
        nameFa: 'قالب وب',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
    const publish = publishingService(prisma, adapters);
    const batch = await publish.createBatch(
      INTEGRATION_COMPANY_ID,
      { priceDate: today, channels: [{ channel: 'WEBSITE' }], variantIds: [variantId] },
      actor(),
      {},
    );
    batchId = batch.batch.id;
    await publishItemHandler(prisma, adapters).handle({ itemId: batch.items[0].id });

    result = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    expect(result.items.map((i: { variantId: string }) => i.variantId)).toContain(variantId);
  });

  it('publicapi.key placeholder auth: matching key resolves the company, wrong key 401', async () => {
    await prisma.setting.create({
      data: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.key', value: 'p5-secret-key', category: 'publicapi' },
    });
    const api = publicApiService(prisma);
    expect(await api.resolveCompanyId({ apiKey: 'p5-secret-key' })).toBe(INTEGRATION_COMPANY_ID);
    await expect(api.resolveCompanyId({ apiKey: 'wrong' })).rejects.toBeInstanceOf(UnauthorizedError);
    // Explicit companyId still scopes (placeholder per-company keys).
    expect(await api.resolveCompanyId({ companyId: INTEGRATION_COMPANY_ID })).toBe(INTEGRATION_COMPANY_ID);
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, key: { startsWith: 'publicapi.' } } });
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    if (batchId) {
      await prisma.publishBatchItem.deleteMany({ where: { batchId } });
      await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    }
    if (configId) await prisma.integrationConfig.deleteMany({ where: { id: configId } });
    if (templateRowId) await prisma.publishingTemplate.deleteMany({ where: { id: templateRowId } });
    if (portalAccountId) await prisma.portalAccount.deleteMany({ where: { id: portalAccountId } });
    if (phoneId) await prisma.partyPhone.deleteMany({ where: { id: phoneId } });
    if (partyId) await prisma.party.deleteMany({ where: { id: partyId } });
    if (variantId) {
      await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
      await prisma.productVariant.deleteMany({ where: { id: variantId } });
      await prisma.productTemplate.deleteMany({ where: { id: templateId } });
      await prisma.productCategory.deleteMany({ where: { id: categoryId } });
      await prisma.uom.deleteMany({ where: { id: uomId } });
    }
    await disconnectIntegrationPrisma();
  });
});
