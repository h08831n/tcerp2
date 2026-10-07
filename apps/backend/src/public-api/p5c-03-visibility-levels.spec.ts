import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  createVariantInCompany,
  dailyPriceService,
  makeAdapters,
  publicApiService,
  publishItemHandler,
  publishingService,
} from '../testing/p5-fixtures';
import { TemplatesService } from '../products/templates.service';
import { AuditService } from '../audit/audit.service';
import { todayKey } from '../pricing/day';

/**
 * p5c-03 public API visibility levels. The Setting `publicapi.visibility`
 * selects what /api/public/prices* exposes:
 *   ALL (default) → every ACTIVE public variant's day prices;
 *   PUBLISHED_ONLY → only variants with a SUCCESS WEBSITE publish item;
 *   PORTAL_ONLY → prices* answer 403 PORTAL_REQUIRED, portal lookup stays
 *   open (it exposes nothing).
 * A variant with isPublic=false is excluded from public endpoints in ALL and
 * PUBLISHED_ONLY modes (toggle via PATCH
 * /api/products/templates/:id/variants/:variantId). The legacy
 * `publicapi.website_only_published=true` aliases to PUBLISHED_ONLY.
 */
describeIntegration('p5c-03 public-api visibility levels', () => {
  const prisma = integrationPrisma();
  const marker = `p5c-03-${Date.now()}`;
  let actorId = '';
  let publicVariantId = '';
  let hiddenVariantId = '';
  let unpublishedVariantId = '';
  let unpublishedUomId = '';
  let unpublishedTemplateId = '';
  let templateId = '';
  let categoryId = '';
  let uomId = '';
  let configId = '';
  let templateRowId = '';
  let batchId = '';
  const today = todayKey();
  const actor = () => ({ id: actorId, username: 'admin' });
  const adapters = makeAdapters();

  const setVisibility = async (value: string | null) => {
    if (value === null) {
      await prisma.setting.deleteMany({
        where: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.visibility' },
      });
      return;
    }
    await prisma.setting.upsert({
      where: { companyId_key: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.visibility' } },
      create: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.visibility', value, category: 'publicapi' },
      update: { value },
    });
  };

  beforeAll(async () => {
    actorId = await adminUserId(prisma);

    const visible = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, `${marker}-v1`);
    publicVariantId = visible.variantId;
    templateId = visible.templateId;
    categoryId = visible.categoryId;
    uomId = visible.uomId;

    // Hidden variant on the SAME template — only isPublic differs.
    const hiddenVariant = await prisma.productVariant.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        templateId,
        sku: `P5-${marker}-v2`,
        nameFa: `وارینت مخفی ${marker}`,
        combinationKey: `p5c03h=${marker}`,
        defaultUomId: uomId,
        isPublic: false,
      },
    });
    hiddenVariantId = hiddenVariant.id;

    const unpublished = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, `${marker}-v3`);
    unpublishedVariantId = unpublished.variantId;
    unpublishedUomId = unpublished.uomId;
    unpublishedTemplateId = unpublished.templateId;

    const pricing = dailyPriceService(prisma);
    for (const variantId of [publicVariantId, hiddenVariantId, unpublishedVariantId]) {
      await pricing.upsert(
        INTEGRATION_COMPANY_ID,
        { productVariantId: variantId, date: today, uomId, price: 11111 },
        actor(),
        {},
      );
    }

    // Publishing infra for the PUBLISHED_ONLY leg.
    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5c-03-web-${marker}`,
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
        code: `P5C03-${marker}`,
        nameFa: 'قالب وب',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
  });

  it('ALL: every active PUBLIC variant appears — isPublic=false is hidden', async () => {
    const api = publicApiService(prisma);
    await setVisibility(null); // default
    const result = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    const ids = result.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).toContain(publicVariantId);
    expect(ids).toContain(unpublishedVariantId);
    expect(ids).not.toContain(hiddenVariantId);
  });

  it('PUBLISHED_ONLY: only published PUBLIC variants appear (published-but-hidden stays out)', async () => {
    await setVisibility('PUBLISHED_ONLY');
    const api = publicApiService(prisma);
    const before = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    expect(before.items).toEqual([]); // nothing published yet

    const publish = publishingService(prisma, adapters);
    const batch = await publish.createBatch(
      INTEGRATION_COMPANY_ID,
      {
        priceDate: today,
        channels: [{ channel: 'WEBSITE' }],
        variantIds: [publicVariantId, hiddenVariantId], // hidden variant IS published
      },
      actor(),
      {},
    );
    batchId = batch.batch.id;
    for (const item of batch.items) {
      await publishItemHandler(prisma, adapters).handle({ itemId: item.id });
    }

    const after = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    expect(after.items.map((i: { variantId: string }) => i.variantId)).toEqual([publicVariantId]);
  });

  it('the legacy publicapi.website_only_published=true aliases to PUBLISHED_ONLY', async () => {
    await setVisibility(null);
    await prisma.setting.upsert({
      where: {
        companyId_key: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.website_only_published' },
      },
      create: {
        companyId: INTEGRATION_COMPANY_ID,
        key: 'publicapi.website_only_published',
        value: true,
        category: 'publicapi',
      },
      update: { value: true },
    });
    const api = publicApiService(prisma);
    const result = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    expect(result.items.map((i: { variantId: string }) => i.variantId)).toEqual([publicVariantId]);
    await prisma.setting.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, key: 'publicapi.website_only_published' },
    });
  });

  it('PORTAL_ONLY: /prices* answer 403 PORTAL_REQUIRED, the portal lookup stays open', async () => {
    await setVisibility('PORTAL_ONLY');
    const api = publicApiService(prisma);

    await expect(api.prices(INTEGRATION_COMPANY_ID, { date: today })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
      message: 'PORTAL_REQUIRED',
    });
    await expect(api.priceHistory(INTEGRATION_COMPANY_ID, publicVariantId, 7)).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'PORTAL_REQUIRED',
    });

    // The lookup leaks nothing — it answers {matched, linked} for any mobile.
    const lookup = await api.portalLookup(INTEGRATION_COMPANY_ID, '09350000000');
    expect(lookup).toEqual({ matched: false, linked: false });
  });

  it('history of a hidden variant is indistinguishable from an unknown one', async () => {
    await setVisibility(null);
    const api = publicApiService(prisma);
    await expect(api.priceHistory(INTEGRATION_COMPANY_ID, hiddenVariantId, 7)).rejects.toThrow(
      'Product variant not found',
    );
  });

  it('the variant PATCH toggles isPublic (products.edit route → TemplatesService.updateVariant)', async () => {
    const templates = new TemplatesService(prisma as never, new AuditService(prisma as never));
    const variant = await prisma.productVariant.findUniqueOrThrow({
      where: { id: unpublishedVariantId },
      select: { version: true },
    });
    const updated = await templates.updateVariant(
      INTEGRATION_COMPANY_ID,
      unpublishedTemplateId,
      unpublishedVariantId,
      { isPublic: false, version: variant.version },
      actor(),
      {},
    );
    expect(updated.isPublic).toBe(false);

    const api = publicApiService(prisma);
    const result = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    const ids = result.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).toContain(publicVariantId);
    expect(ids).not.toContain(unpublishedVariantId);
    expect(ids).not.toContain(hiddenVariantId);
  });

  it('an invalid visibility value falls back to ALL (defensive default)', async () => {
    await setVisibility('SOMETHING_ELSE');
    const api = publicApiService(prisma);
    const result = await api.prices(INTEGRATION_COMPANY_ID, { date: today });
    expect(Array.isArray(result.items)).toBe(true);
    const ids = result.items.map((i: { variantId: string }) => i.variantId);
    expect(ids).toContain(publicVariantId);
    expect(ids).not.toContain(hiddenVariantId);
  });

  afterAll(async () => {
    await prisma.setting.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, key: { startsWith: 'publicapi.' } },
    });
    await prisma.queueJob.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' },
    });
    if (batchId) {
      await prisma.publishBatchItem.deleteMany({ where: { batchId } });
      await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    }
    if (configId) await prisma.integrationConfig.deleteMany({ where: { id: configId } });
    if (templateRowId) await prisma.publishingTemplate.deleteMany({ where: { id: templateRowId } });
    await prisma.dailyPrice.deleteMany({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        productVariantId: { in: [publicVariantId, hiddenVariantId, unpublishedVariantId] },
      },
    });
    await prisma.productVariant.deleteMany({
      where: { id: { in: [publicVariantId, hiddenVariantId, unpublishedVariantId] } },
    });
    await prisma.productTemplate.deleteMany({
      where: { id: { in: [templateId, unpublishedTemplateId].filter(Boolean) } },
    });
    if (categoryId) await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    if (uomId) {
      await prisma.uom.deleteMany({ where: { id: { in: [uomId, unpublishedUomId].filter(Boolean) } } });
      await prisma.uomCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { in: [`P5W-${marker}-v1`, `P5W-${marker}-v3`] } } });
    }
    await disconnectIntegrationPrisma();
  });
});
