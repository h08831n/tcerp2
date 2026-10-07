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
  automationService,
  automationRunHandler,
  makeAdapters,
} from '../testing/p5-fixtures';
import { todayKey } from '../pricing/day';

/**
 * p5-11 automation-price-updated: an enabled PRICE_UPDATED rule produces an
 * async run row (idempotencyKey `auto:{ruleId}:{variantId}:{date}`) + queue
 * job; the `automation.run` handler creates the publish batch ONCE; a
 * duplicate event becomes a SKIPPED run row and never double-publishes.
 */
describeIntegration('p5-11 automation-price-updated', () => {
  const prisma = integrationPrisma();
  const marker = `p5-11-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  let templateId = '';
  let categoryId = '';
  let configId = '';
  let templateRowId = '';
  let ruleId = '';
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

    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5-11-tg-${marker}`,
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
        code: `P5-11-${marker}`,
        nameFa: 'قالب اتوماسیون',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;

    const rule = await prisma.automationRule.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P5-11-${marker}`,
        nameFa: 'انتشار خودکار تست',
        triggerType: 'PRICE_UPDATED',
        triggerConfig: { channels: ['TELEGRAM'] },
        conditionConfig: { all: [{ field: 'priceChanged', equals: true }] },
        actionType: 'PUBLISH_PRICE',
        actionConfig: { channels: ['TELEGRAM'] },
        enabled: true,
      },
    });
    ruleId = rule.id;
  });

  it('price upsert → run row + queue job → handler publishes the batch once', async () => {
    // The pricing service is wired with the automation hook (module wiring).
    const pricing = dailyPriceService(prisma, automationService(prisma, publishingService(prisma, adapters)));
    await pricing.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 26000 },
      actor(),
      {},
    );

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { ruleId, triggerPayload: { path: ['variantId'], equals: variantId } },
      orderBy: { createdAt: 'desc' as const },
    });
    expect(run.status).toBe('PENDING');
    expect(run.idempotencyKey).toBe(`auto:${ruleId}:${variantId}:${today}`);
    expect(run.ruleVersion).toBe(1);

    const job = await prisma.queueJob.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'automation.run', idempotencyKey: run.idempotencyKey },
    });
    expect((job.payload as { runId: string }).runId).toBe(run.id);

    // Execute the async run (queue worker equivalent).
    await automationRunHandler(
      automationService(prisma, publishingService(prisma, adapters)),
    ).handle({ runId: run.id });

    const executed = await prisma.automationRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(executed.status).toBe('SUCCESS');

    const batch = await prisma.publishBatch.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, items: { some: { renderedPayload: { path: ['variantIds'], array_contains: [variantId] } } } },
      orderBy: { createdAt: 'desc' as const },
    });
    expect(batch.notes).toContain('automation');
    const batchItems = await prisma.publishBatchItem.findMany({ where: { batchId: batch.id } });
    expect(batchItems).toHaveLength(1);

    // Run the handler AGAIN (duplicate delivery) → no second batch.
    await automationRunHandler(
      automationService(prisma, publishingService(prisma, adapters)),
    ).handle({ runId: run.id });
    const batchesAfter = await prisma.publishBatch.count({
      where: { companyId: INTEGRATION_COMPANY_ID, notes: { contains: 'automation' } },
    });
    void batchesAfter;
    const batchCount = await prisma.publishBatchItem.count({ where: { renderedPayload: { path: ['variantIds'], array_contains: [variantId] } } });
    expect(batchCount).toBe(1);
    void batch;

    // Process the publish item end-to-end for completeness.
    const publishHandler = publishItemHandler(prisma, adapters);
    const tg = adapters.find((a) => a.channel === 'TELEGRAM');
    void tg;
    await publishHandler.handle({ itemId: batchItems[0].id });
    const item = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: batchItems[0].id } });
    expect(item.status).toBe('SUCCESS');
  });

  it('duplicate event (same day re-upsert) → SKIPPED run row, no double publish', async () => {
    const pricing = dailyPriceService(prisma, automationService(prisma, publishingService(prisma, adapters)));
    await pricing.upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: today, uomId, price: 27000 },
      actor(),
      {},
    );

    const skippedRun = await prisma.automationRun.findFirstOrThrow({
      where: { ruleId, status: 'SKIPPED' },
      orderBy: { createdAt: 'desc' as const },
    });
    expect(skippedRun.error).toBe('DUPLICATE_EVENT');
    expect((skippedRun.conditionsResult as { duplicateOf: string }).duplicateOf).toBe(
      `auto:${ruleId}:${variantId}:${today}`,
    );

    // Exactly ONE queue job for the (rule, variant, date) event.
    const jobs = await prisma.queueJob.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'automation.run', idempotencyKey: `auto:${ruleId}:${variantId}:${today}` },
    });
    expect(jobs).toHaveLength(1);

    // Exactly ONE publish batch item covers the variant.
    const items = await prisma.publishBatchItem.count({
      where: { renderedPayload: { path: ['variantIds'], array_contains: [variantId] } },
    });
    expect(items).toBe(1);
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: { in: ['automation.run', 'publish.batch_item'] } } });
    await prisma.publishBatchItem.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID } });
    await prisma.publishBatch.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, notes: { contains: 'automation' } } });
    await prisma.automationRun.deleteMany({ where: { ruleId } });
    await prisma.automationRule.deleteMany({ where: { id: ruleId } });
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
