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
import { publishItemIdempotencyKey } from './publishing.service';
import { todayKey } from '../pricing/day';

/**
 * p5-07 mock-provider-failure: config.forceFail → the item is FAILED with
 * lastError + providerResponse stored and the batch recomputes to FAILED;
 * retryItem → PENDING with attemptCount PRESERVED, re-enqueued as a NEW queue
 * job (attempt-generation key); after the config stops forcing the failure,
 * the handler run succeeds and attemptCount is incremented (1 → 2).
 */
describeIntegration('p5-07 mock-provider-failure', () => {
  const prisma = integrationPrisma();
  const marker = `p5-07-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let configId = '';
  let templateRowId = '';
  let batchId = '';
  let itemId = '';
  let firstQueueJobId = '';
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
      { productVariantId: variantId, date: todayKey(), uomId, price: 22000 },
      { id: actorId, username: 'admin' },
      {},
    );

    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5-07-wa-${marker}`,
        name: 'WhatsApp mock (forceFail)',
        type: 'WHATSAPP',
        isActive: true,
        config: { mode: 'mock', forceFail: true },
      },
    });
    configId = config.id;
    const template = await prisma.publishingTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        channel: 'WHATSAPP',
        code: `P5-07-${marker}`,
        nameFa: 'قالب واتساپ',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
  });

  it('forceFail → FAILED with lastError + providerResponse; batch FAILED', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      { priceDate: todayKey(), channels: [{ channel: 'WHATSAPP' }], variantIds: [variantId] },
      { id: actorId, username: 'admin' },
      {},
    );
    batchId = result.batch.id;
    itemId = result.items[0].id;
    firstQueueJobId = result.queueJobIds[0];

    await publishItemHandler(prisma, adapters).handle({ itemId });

    const item = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.status).toBe('FAILED');
    expect(item.attemptCount).toBe(1);
    expect(item.lastError).toBe('MOCK_FORCE_FAIL');
    expect((item.providerResponse as { error: string }).error).toBe('MOCK_FORCE_FAIL');

    const batch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('FAILED');
  });

  it('retryItem resets PENDING (attempt preserved) and enqueues a NEW job', async () => {
    const service = publishingService(prisma, adapters);
    const retried = await service.retryItem(
      INTEGRATION_COMPANY_ID,
      itemId,
      { id: actorId, username: 'admin' },
      {},
    );
    expect(retried.status).toBe('PENDING');
    expect(retried.attemptCount).toBe(1); // preserved
    expect(retried.queueJobId).not.toBe(firstQueueJobId); // NEW queue row

    const job = await prisma.queueJob.findUniqueOrThrow({ where: { id: retried.queueJobId } });
    expect(job.idempotencyKey).toBe(publishItemIdempotencyKey(itemId, 1));

    const batch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('PROCESSING');
  });

  it('after the failure is removed, the retried run SUCCEEDS and attemptCount increments to 2', async () => {
    await prisma.integrationConfig.update({
      where: { id: configId },
      data: { config: { mode: 'mock', forceFail: false } },
    });

    await publishItemHandler(prisma, adapters).handle({ itemId });

    const item = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: itemId } });
    expect(item.status).toBe('SUCCESS');
    expect(item.attemptCount).toBe(2); // preserved + incremented
    expect(item.lastError).toBeNull();
    expect((item.providerResponse as { provider: string }).provider).toBe('mock');

    const batch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(batch.status).toBe('COMPLETED');
  });

  it('retrying a non-FAILED item is rejected', async () => {
    const service = publishingService(prisma, adapters);
    await expect(
      service.retryItem(INTEGRATION_COMPANY_ID, itemId, { id: actorId, username: 'admin' }, {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
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
