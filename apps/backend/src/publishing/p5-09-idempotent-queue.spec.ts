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
  publishingService,
  publishItemHandler,
  makeQueueService,
  makeAdapters,
} from '../testing/p5-fixtures';
import { MockPublishingAdapter } from './adapters/mock-publishing.adapter';
import { todayKey } from '../pricing/day';

/**
 * p5-09 idempotent-queue: enqueueing twice with the same idempotencyKey
 * resolves to the SAME durable job; re-processing an already-successful item
 * never double-sends (the mock records exactly ONE send per successful item).
 */
describeIntegration('p5-09 idempotent-queue', () => {
  const prisma = integrationPrisma();
  const marker = `p5-09-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let configId = '';
  let templateRowId = '';
  let batchId = '';
  let itemId = '';
  const adapters = makeAdapters();
  const actor = () => ({ id: actorId, username: 'admin' });

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;

    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: todayKey(), uomId, price: 17500 },
      actor(),
      {},
    );
    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5-09-web-${marker}`,
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
        code: `P5-09-${marker}`,
        nameFa: 'قالب وب',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
  });

  it('same idempotencyKey → same queue job (DB-level dedupe)', async () => {
    const queue = makeQueueService(prisma);
    const first = await queue.enqueue({
      jobType: 'publish.batch_item',
      companyId: INTEGRATION_COMPANY_ID,
      payload: { companyId: INTEGRATION_COMPANY_ID, itemId: 'no-such-item' },
      idempotencyKey: `p5-09-dedupe:${marker}`,
    });
    const second = await queue.enqueue({
      jobType: 'publish.batch_item',
      companyId: INTEGRATION_COMPANY_ID,
      payload: { companyId: INTEGRATION_COMPANY_ID, itemId: 'no-such-item' },
      idempotencyKey: `p5-09-dedupe:${marker}`,
    });
    expect(second.id).toBe(first.id);
    const rows = await prisma.queueJob.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `p5-09-dedupe:${marker}` },
    });
    expect(rows).toHaveLength(1);
    await prisma.queueJob.deleteMany({ where: { id: first.id } });
  });

  it('reprocessing a SUCCESS item does not double-send', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      { priceDate: todayKey(), channels: [{ channel: 'WEBSITE' }], variantIds: [variantId] },
      actor(),
      {},
    );
    batchId = result.batch.id;
    itemId = result.items[0].id;

    const handler = publishItemHandler(prisma, adapters);
    await handler.handle({ itemId });
    await handler.handle({ itemId }); // duplicate delivery
    await handler.handle({ itemId }); // …and again

    const website = adapters.find((a) => a.channel === 'WEBSITE') as MockPublishingAdapter;
    expect(website.sent).toHaveLength(1);

    const item = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.status).toBe('SUCCESS');
    expect(item.attemptCount).toBe(1);
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    await prisma.publishBatchItem.deleteMany({ where: { batchId } });
    await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    await prisma.integrationConfig.deleteMany({ where: { id: configId } });
    await prisma.publishingTemplate.deleteMany({ where: { id: templateRowId } });
    await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.uom.deleteMany({ where: { id: uomId } });
    await disconnectIntegrationPrisma();
  });
});
