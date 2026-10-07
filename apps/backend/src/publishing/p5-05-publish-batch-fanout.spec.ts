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
 * p5-05 publish-batch-fanout: one batch over 3 channels creates exactly
 * 3 items + 3 queue jobs (jobType `publish.batch_item`, idempotencyKey
 * `publish:{itemId}`); the batch stays PENDING until items execute.
 */
describeIntegration('p5-05 publish-batch-fanout', () => {
  const prisma = integrationPrisma();
  const marker = `p5-05-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  const templateIds: string[] = [];
  let batchId = '';
  const adapters = makeAdapters();

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker, {
      withAttributes: [
        { code: 'size', value: '۱۶' },
        { code: 'grade', value: 'A3' },
      ],
    });
    variantId = fixture.variantId;
    uomId = fixture.uomId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;

    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: todayKey(), uomId, price: 25000 },
      { id: actorId, username: 'admin' },
      {},
    );

    for (const [i, channel] of ['TELEGRAM', 'WEBSITE', 'WHATSAPP'].entries()) {
      const template = await prisma.publishingTemplate.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          channel: channel as 'TELEGRAM' | 'WEBSITE' | 'WHATSAPP',
          code: `P5-05-${marker}-${i}`,
          nameFa: `قالب ${channel}`,
          bodyTemplate: '{product} {size} {grade}: {price} {uom} — {date}',
        },
      });
      templateIds.push(template.id);
    }
  });

  it('3 channels → 3 items + 3 queue jobs, batch PENDING', async () => {
    const service = publishingService(prisma, adapters);
    const result = await service.createBatch(
      INTEGRATION_COMPANY_ID,
      {
        priceDate: todayKey(),
        channels: [
          { channel: 'TELEGRAM' },
          { channel: 'WEBSITE' },
          { channel: 'WHATSAPP' },
        ],
        variantIds: [variantId],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    batchId = result.batch.id;

    expect(result.items).toHaveLength(3);
    expect(result.queueJobIds).toHaveLength(3);
    expect(result.batch.status).toBe('PENDING');

    // Each item carries the rendered payload built from that day's price row.
    for (const item of result.items) {
      const payload = item.renderedPayload as { messageText: string; variantIds: string[] };
      expect(payload.messageText).toContain('25000');
      expect(payload.messageText).toContain('۱۶');
      expect(payload.messageText).toContain('A3');
      expect(payload.variantIds).toEqual([variantId]);
    }

    // One durable queue job per item, keyed `publish:{itemId}`.
    const jobs = await prisma.queueJob.findMany({
      where: { id: { in: result.queueJobIds } },
    });
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.jobType).toBe('publish.batch_item');
      expect(job.companyId).toBe(INTEGRATION_COMPANY_ID);
      expect(job.status === 'PENDING' || job.status === 'SCHEDULED').toBe(true);
      const item = result.items.find((i: { id: string }) => `publish:${i.id}` === job.idempotencyKey);
      expect(item).toBeDefined();
      expect((job.payload as { itemId: string }).itemId).toBe(item!.id);
    }
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    if (batchId) {
      await prisma.publishBatchItem.deleteMany({ where: { batchId } });
      await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    }
    await prisma.publishingTemplate.deleteMany({ where: { id: { in: templateIds } } });
    if (variantId) {
      await prisma.variantAttributeValue.deleteMany({ where: { variantId } });
      await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
      await prisma.productVariant.deleteMany({ where: { id: variantId } });
      await prisma.productTemplate.deleteMany({ where: { id: templateId } });
      await prisma.productCategory.deleteMany({ where: { id: categoryId } });
      await prisma.uom.deleteMany({ where: { id: uomId } });
    }
    await disconnectIntegrationPrisma();
  });
});
