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
import { todayKey } from '../pricing/day';

/**
 * p5-10 cancel-item: a PENDING item can be cancelled (status CANCELLED, queue
 * job cancelled best-effort, batch recomputed); a SUCCESS item cannot.
 */
describeIntegration('p5-10 cancel-item', () => {
  const prisma = integrationPrisma();
  const marker = `p5-10-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let configId = '';
  let templateRowId = '';
  const batchIds: string[] = [];
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
      { productVariantId: variantId, date: todayKey(), uomId, price: 18500 },
      actor(),
      {},
    );
    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5-10-tg-${marker}`,
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
        code: `P5-10-${marker}`,
        nameFa: 'قالب کنسل',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
  });

  it('cancelling a PENDING item → CANCELLED; batch recomputes (mixed → PARTIAL)', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      {
        priceDate: todayKey(),
        channels: [
          { channel: 'TELEGRAM', destination: '@dest-1' },
          { channel: 'TELEGRAM', destination: '@dest-2' },
        ],
        variantIds: [variantId],
      },
      actor(),
      {},
    );
    batchIds.push(result.batch.id);
    const [cancelTarget, successTarget] = result.items;

    await service.cancelItem(INTEGRATION_COMPANY_ID, cancelTarget.id, actor(), {});
    const cancelled = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: cancelTarget.id } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.finishedAt).not.toBeNull();

    // The other item is still PENDING → batch PROCESSING.
    let batch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: result.batch.id } });
    expect(batch.status).toBe('PROCESSING');

    // Success on the remaining item → SUCCESS + CANCELLED = PARTIAL.
    await publishItemHandler(prisma, adapters).handle({ itemId: successTarget.id });
    batch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: result.batch.id } });
    expect(batch.status).toBe('PARTIAL');
  });

  it('a SUCCESS item cannot be cancelled', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      { priceDate: todayKey(), channels: [{ channel: 'TELEGRAM', destination: '@dest-3' }], variantIds: [variantId] },
      actor(),
      {},
    );
    batchIds.push(result.batch.id);
    const item = result.items[0];
    await publishItemHandler(prisma, adapters).handle({ itemId: item.id });

    await expect(
      service.cancelItem(INTEGRATION_COMPANY_ID, item.id, actor(), {}),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    for (const batchId of batchIds) {
      await prisma.publishBatchItem.deleteMany({ where: { batchId } });
      await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    }
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
