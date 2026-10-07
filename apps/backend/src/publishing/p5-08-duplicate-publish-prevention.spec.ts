import { Prisma } from '@prisma/client';
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
  makeAdapters,
} from '../testing/p5-fixtures';
import { todayKey } from '../pricing/day';

/**
 * p5-08 duplicate-publish-prevention: the UNIQUE (batchId, channel,
 * destination) rejects duplicate publishing — a duplicate entry inside one
 * request is SKIPPED (with a report) and a raw duplicate insert hits P2002.
 */
describeIntegration('p5-08 duplicate-publish-prevention', () => {
  const prisma = integrationPrisma();
  const marker = `p5-08-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let templateRowId = '';
  let batchId = '';
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
      { productVariantId: variantId, date: todayKey(), uomId, price: 19000 },
      { id: actorId, username: 'admin' },
      {},
    );
    const template = await prisma.publishingTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        channel: 'TELEGRAM',
        code: `P5-08-${marker}`,
        nameFa: 'قالب تکرار',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;
  });

  it('the same channel twice in one request → ONE item, the duplicate SKIPPED', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      {
        priceDate: todayKey(),
        channels: [
          { channel: 'TELEGRAM', destination: '@channel_a' },
          { channel: 'TELEGRAM', destination: '@channel_a' }, // duplicate
        ],
        variantIds: [variantId],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    batchId = result.batch.id;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].destination).toBe('@channel_a');
    expect(result.skippedDuplicates).toEqual([{ channel: 'TELEGRAM', destination: '@channel_a' }]);
  });

  it('a direct duplicate insert hits the DB unique (P2002)', async () => {
    await expect(
      prisma.publishBatchItem.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          batchId,
          channel: 'TELEGRAM',
          destination: '@channel_a',
          priceDate: new Date(todayKey()),
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' } as Prisma.PrismaClientKnownRequestError);
  });

  it('same channel with DIFFERENT destinations → two items', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      {
        priceDate: todayKey(),
        channels: [
          { channel: 'TELEGRAM', destination: '@channel_a' },
          { channel: 'TELEGRAM', destination: '@channel_b' },
        ],
        variantIds: [variantId],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    // Note: this is a SECOND batch — the unique is per (batch, channel, dest).
    expect(result.items).toHaveLength(2);
    await prisma.queueJob.deleteMany({ where: { id: { in: result.queueJobIds } } });
    await prisma.publishBatchItem.deleteMany({ where: { batchId: result.batch.id } });
    await prisma.publishBatch.deleteMany({ where: { id: result.batch.id } });
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    await prisma.publishBatchItem.deleteMany({ where: { batchId } });
    await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    await prisma.publishingTemplate.deleteMany({ where: { id: templateRowId } });
    await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.uom.deleteMany({ where: { id: uomId } });
    await disconnectIntegrationPrisma();
  });
});
