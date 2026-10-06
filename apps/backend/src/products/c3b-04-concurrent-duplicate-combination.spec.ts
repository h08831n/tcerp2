import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { AttributesService } from './attributes.service';
import { CategoriesService } from './categories.service';
import { TemplatesService } from './templates.service';

/**
 * c3b-04 — concurrent-duplicate-combination (live DB): two generate calls
 * racing on the SAME combination produce exactly ONE variant row. The DB
 * unique (template_id, combination_key) is the authority: the winner's tx
 * commits; the loser either reports the combination skipped with
 * VARIANT_COMBINATION_EXISTS (pre-check saw it commit) or surfaces the
 * P2002 as ConflictError('VARIANT_COMBINATION_EXISTS') (lost the insert
 * race). No pre-check-only logic: the combination_key column is persisted
 * and matches the canonical buildCombinationKey format.
 */
describeIntegration('c3b-04 concurrent-duplicate-combination (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const attributes = new AttributesService(prisma as never, audit);
  const categories = new CategoriesService(prisma as never, audit);
  const templates = new TemplatesService(prisma as never, audit);

  let attributeId: string;
  let valueId: string;
  let categoryId: string;
  let templateId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    const attribute = (await attributes.createAttribute(
      INTEGRATION_COMPANY_ID,
      { code: `SIZE-C04-${marker}`, nameFa: 'سایز' },
      admin,
      {},
    )) as { id: string };
    attributeId = attribute.id;
    valueId = (
      (await attributes.createValue(
        INTEGRATION_COMPANY_ID,
        attributeId,
        { attributeId, code: 'M', valueFa: 'متوسط' },
        admin,
        {},
      )) as { id: string }
    ).id;
    categoryId = (
      (await categories.create(
        INTEGRATION_COMPANY_ID,
        { code: `C04-${marker}`, nameFa: 'دسته c3b-04' },
        admin,
        {},
      )) as { id: string }
    ).id;
    templateId = (
      (await templates.create(
        INTEGRATION_COMPANY_ID,
        {
          categoryId,
          nameFa: 'محصول رقابتی',
          internalCode: `C04-${marker}`,
        },
        admin,
        {},
      )) as { id: string }
    ).id;
    await templates.addAttribute(
      INTEGRATION_COMPANY_ID,
      templateId,
      { attributeId, displayOrder: 1, createsVariants: true },
      admin,
      {},
    );
  });

  it('two parallel generate calls on the same combination → exactly 1 variant row', async () => {
    const dto = {
      combinations: [{ selections: [{ attributeId, valueId }] }],
    };

    const results = await Promise.allSettled([
      templates.generateVariants(INTEGRATION_COMPANY_ID, templateId, dto, admin, {}),
      templates.generateVariants(INTEGRATION_COMPANY_ID, templateId, dto, admin, {}),
    ]);

    type GenerateResult = Awaited<ReturnType<TemplatesService['generateVariants']>>;
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<GenerateResult> => r.status === 'fulfilled',
    );
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    // The loser either reports the skip or fails with the stable conflict code.
    const skippedWithExists = fulfilled.some((r) =>
      r.value.skipped.some((s) => s.reason === 'VARIANT_COMBINATION_EXISTS'),
    );
    const rejectedWithExists = rejected.some((r) => {
      const err = r.reason as { message?: string };
      return err?.message === 'VARIANT_COMBINATION_EXISTS';
    });
    expect(fulfilled.length + rejected.length).toBe(2);
    expect(skippedWithExists || rejectedWithExists).toBe(true);

    // The winner reported exactly one created variant with the canonical key.
    const winner = fulfilled.find((r) => r.value.created.length === 1);
    expect(winner).toBeDefined();

    // Exactly ONE variant row exists — no duplicate combination survived.
    const variants = await prisma.productVariant.findMany({
      where: { templateId },
      select: { id: true, sku: true, combinationKey: true, values: true },
    });
    expect(variants).toHaveLength(1);
    expect(variants[0].combinationKey).toBe(`${attributeId}=${valueId}`);
    expect(variants[0].values.map((v) => v.attributeValueId)).toEqual([valueId]);
  });

  it('a third sequential generate call is skipped with VARIANT_COMBINATION_EXISTS (skip-with-report)', async () => {
    const result = (await templates.generateVariants(
      INTEGRATION_COMPANY_ID,
      templateId,
      { combinations: [{ selections: [{ attributeId, valueId }] }] },
      admin,
      {},
    )) as { created: unknown[]; skipped: Array<{ reason: string }> };
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0].reason).toBe('VARIANT_COMBINATION_EXISTS');
  });

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { templateId } });
    await prisma.productTemplateAttributeValue.deleteMany({ where: { templateAttribute: { templateId } } });
    await prisma.productTemplateAttribute.deleteMany({ where: { templateId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.attributeValue.deleteMany({ where: { attributeId } });
    await prisma.attribute.deleteMany({ where: { id: attributeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.auditLog
      .deleteMany({
        where: {
          OR: [
            { entityId: { in: [templateId, attributeId, valueId, categoryId] } },
            { entityType: 'product_variant', newValues: { path: ['templateId'], equals: templateId } },
            { entityType: 'product_template_attribute_value', newValues: { path: ['templateId'], equals: templateId } },
          ],
        },
      })
      .catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
