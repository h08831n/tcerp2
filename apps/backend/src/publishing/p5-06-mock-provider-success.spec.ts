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
  makeAdapters,
} from '../testing/p5-fixtures';
import { MockPublishingAdapter } from './adapters/mock-publishing.adapter';
import { todayKey } from '../pricing/day';

/**
 * p5-06 mock-provider-success: the queue handler processes the item →
 * SUCCESS with a stored providerResponse; the batch recomputes to COMPLETED
 * with finishedAt; the mock records exactly one send.
 */
describeIntegration('p5-06 mock-provider-success', () => {
  const prisma = integrationPrisma();
  const marker = `p5-06-${Date.now()}`;
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

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;

    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: todayKey(), uomId, price: 21000 },
      { id: actorId, username: 'admin' },
      {},
    );

    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5-06-tg-${marker}`,
        name: 'Telegram mock',
        type: 'TELEGRAM',
        isActive: true,
        config: { mode: 'mock' },
      },
    });
    configId = config.id;

    const template = await prisma.publishingTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        channel: 'TELEGRAM',
        code: `P5-06-${marker}`,
        nameFa: 'قالب تست',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
  });

  it('handler processes the item → SUCCESS, providerResponse stored, batch COMPLETED', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      { priceDate: todayKey(), channels: [{ channel: 'TELEGRAM' }], variantIds: [variantId] },
      { id: actorId, username: 'admin' },
      {},
    );
    batchId = result.batch.id;
    itemId = result.items[0].id;

    const handler = publishItemHandler(prisma, adapters);
    await handler.handle({ itemId });

    const item = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.status).toBe('SUCCESS');
    expect(item.attemptCount).toBe(1);
    expect(item.finishedAt).not.toBeNull();
    expect(item.lastError).toBeNull();
    expect((item.providerResponse as { provider: string }).provider).toBe('mock');
    expect((item.providerResponse as { channel: string }).channel).toBe('TELEGRAM');

    const batch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('COMPLETED');
    expect(batch.finishedAt).not.toBeNull();

    const telegram = adapters.find((a) => a.channel === 'TELEGRAM') as MockPublishingAdapter;
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0].messageText).toContain('21000');
  });

  it('a redelivered queue job does NOT send again (idempotent handler)', async () => {
    const handler = publishItemHandler(prisma, adapters);
    await handler.handle({ itemId }); // same payload twice
    const telegram = adapters.find((a) => a.channel === 'TELEGRAM') as MockPublishingAdapter;
    expect(telegram.sent).toHaveLength(1); // still one send
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
