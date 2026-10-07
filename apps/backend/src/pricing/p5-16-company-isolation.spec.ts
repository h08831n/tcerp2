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
  createCompany,
  cleanupCompany,
  publishingService,
  automationService,
  makeAdapters,
} from '../testing/p5-fixtures';
import { todayKey } from '../pricing/day';

/**
 * p5-16 company isolation: prices, publish batches and automation rules of
 * company A are INVISIBLE to company B (cross-company variants are 404
 * NotFound; lists are empty; rules of A do not run for B).
 */
describeIntegration('p5-16 company-isolation', () => {
  const prisma = integrationPrisma();
  const marker = `p5-16-${Date.now()}`;
  let actorId = '';
  let variantA = { variantId: '', templateId: '', categoryId: '', uomId: '', sku: '' };
  let companyBId = '';
  let ruleAId = '';
  let batchAId = '';
  let templateAId = '';
  const adapters = makeAdapters();
  const actor = () => ({ id: actorId, username: 'admin' });

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    variantA = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    const companyB = await createCompany(prisma, marker);
    companyBId = companyB.id;

    // A daily price, a publish batch and an automation rule in company A.
    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantA.variantId, date: todayKey(), uomId: variantA.uomId, price: 12345 },
      actor(),
      {},
    );
    const template = await prisma.publishingTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        channel: 'TELEGRAM',
        code: `P5-16-${marker}`,
        nameFa: 'قالب A',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateAId = template.id;
    const publish = publishingService(prisma, adapters);
    const batch = await publish.createBatch(
      INTEGRATION_COMPANY_ID,
      { priceDate: todayKey(), channels: [{ channel: 'TELEGRAM' }], variantIds: [variantA.variantId] },
      actor(),
      {},
    );
    batchAId = batch.batch.id;

    const rule = await prisma.automationRule.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P5-16-${marker}`,
        nameFa: 'قانون A',
        triggerType: 'PRICE_UPDATED',
        triggerConfig: { channels: ['TELEGRAM'] },
        actionType: 'PUBLISH_PRICE',
        actionConfig: { channels: ['TELEGRAM'] },
        enabled: true,
      },
    });
    ruleAId = rule.id;
  });

  it('company B cannot price A\'s variant (variant is company-scoped)', async () => {
    const service = dailyPriceService(prisma);
    await expect(
      service.upsert(
        companyBId,
        { productVariantId: variantA.variantId, date: todayKey(), uomId: variantA.uomId, price: 999 },
        actor(),
        {},
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('company B sees no prices, no batches, no rules of company A', async () => {
    // B's price grid is empty.
    const grid = await dailyPriceService(prisma).grid(companyBId, { page: 1, pageSize: 50, skip: 0, take: 50 });
    expect(grid.total).toBe(0);
    expect(grid.items).toEqual([]);

    // B's publish batches list is empty; A's batch is not addressable.
    const publish = publishingService(prisma, adapters);
    const batches = await publish.listBatches(companyBId, {
      page: 1,
      pageSize: 50,
      skip: 0,
      take: 50,
    } as never);
    expect(batches.total).toBe(0);
    await expect(publish.getBatch(companyBId, batchAId)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      publish.retryItem(companyBId, (await prisma.publishBatchItem.findFirstOrThrow({ where: { batchId: batchAId } })).id, actor(), {}),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // B's automation rules list is empty; A's rule is not addressable/runnable.
    const rules = await prisma.automationRule.findMany({ where: { companyId: companyBId } });
    expect(rules).toEqual([]);
    await expect(
      automationService(prisma, publishingService(prisma, adapters)).manualRun(companyBId, ruleAId, {}),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('the daily scan for company B does not execute A\'s rules', async () => {
    const automation = automationService(prisma, publishingService(prisma, adapters));
    const summaries = await automation.dailyScan({ companyId: companyBId, date: todayKey() });
    expect(summaries).toEqual([]);
    const runs = await prisma.automationRun.findMany({ where: { rule: { companyId: companyBId } } });
    expect(runs).toEqual([]);
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    await prisma.publishBatchItem.deleteMany({ where: { batchId: batchAId } });
    await prisma.publishBatch.deleteMany({ where: { id: batchAId } });
    await prisma.publishingTemplate.deleteMany({ where: { id: templateAId } });
    await prisma.automationRule.deleteMany({ where: { id: ruleAId } });
    await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantA.variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variantA.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variantA.templateId } });
    await prisma.productCategory.deleteMany({ where: { id: variantA.categoryId } });
    await prisma.uom.deleteMany({ where: { id: variantA.uomId } });
    await cleanupCompany(prisma, companyBId);
    await disconnectIntegrationPrisma();
  });
});
