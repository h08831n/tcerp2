import { PrismaClient } from '@prisma/client';
import { loadEnvFile } from '../config/configuration';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from './categories.service';
import { TemplatesService } from './templates.service';
import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * p3b-20 — restart-persistence: a template + generated variants written via
 * the services are read back INTACT (values, ordering, SKUs) through a brand
 * new PrismaClient instance — i.e. what a fresh server process would see
 * after a restart.
 */
describeIntegration('p3b-20 restart-persistence (live DB)', () => {
  const marker = Date.now();
  const admin = { id: '', username: 'admin' };
  let categoryId: string;
  let templateId: string;
  let attributeId: string;
  let valueIds: string[] = [];
  const prisma = integrationPrisma();

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    const audit = new AuditService(prisma as never);
    const categories = new CategoriesService(prisma as never, audit);
    const cat = (await categories.create(
      INTEGRATION_COMPANY_ID,
      { code: `P20-${marker}`, nameFa: 'دسته دوام' },
      admin,
      {},
    )) as { id: string };
    categoryId = cat.id;

    const attr = await prisma.attribute.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P20SIZE-${marker}`,
        nameFa: 'سایز',
        values: {
          create: [
            { code: 'S', valueFa: 'کوچک' },
            { code: 'M', valueFa: 'متوسط' },
          ],
        },
      },
      include: { values: { orderBy: { code: 'asc' } } },
    });
    attributeId = attr.id;
    valueIds = attr.values.map((v) => v.id);
  });

  it('a fresh PrismaClient (new process) reads the template + variants intact', async () => {
    // Write phase (this "process").
    const writeAudit = new AuditService(prisma as never);
    const writer = new TemplatesService(prisma as never, writeAudit);
    const template = (await writer.create(
      INTEGRATION_COMPANY_ID,
      {
        categoryId,
        nameFa: 'محصول دوام کُر۲۰',
        internalCode: `P20-${marker}`,
      },
      admin,
      {},
    )) as { id: string };
    templateId = template.id;
    await prisma.productTemplateAttribute.create({
      data: { templateId, attributeId },
    });
    const result = (await writer.generateVariants(
      INTEGRATION_COMPANY_ID,
      templateId,
      {
        combinations: valueIds.map((valueId) => ({
          selections: [{ attributeId, valueId }],
        })),
      },
      admin,
      {},
    )) as { created: Array<{ sku: string }>; skipped: unknown[] };
    expect(result.created).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);

    // Read phase through a COMPLETELY NEW client (restart simulation).
    loadEnvFile();
    const fresh = new PrismaClient();
    try {
      const reread = await fresh.productTemplate.findUniqueOrThrow({
        where: { id: templateId },
        include: {
          attributes: { orderBy: { displayOrder: 'asc' } },
          variants: { include: { values: true } },
        },
      });
      expect(reread.companyId).toBe(INTEGRATION_COMPANY_ID);
      expect(reread.nameFa).toBe('محصول دوام کُر۲۰');
      expect(reread.attributes).toHaveLength(1);
      expect(reread.variants).toHaveLength(2);
      const skus = reread.variants.map((v) => v.sku).sort();
      expect(skus).toEqual(
        [`P20-${marker}-M`, `P20-${marker}-S`].sort(),
      );
      expect(reread.variants.every((v) => v.values.length === 1)).toBe(true);
    } finally {
      await fresh.$disconnect();
    }
  });

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { templateId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productTemplateAttribute.deleteMany({ where: { templateId } });
    await prisma.attribute.deleteMany({ where: { id: attributeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.auditLog.deleteMany({
      where: { entityType: { in: ['product_category', 'product_template', 'product_variant', 'product_template_attribute'] }, entityId: { in: [categoryId, templateId, attributeId] } },
    }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
