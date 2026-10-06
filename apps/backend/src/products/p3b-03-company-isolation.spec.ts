import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from './categories.service';
import { TemplatesService } from './templates.service';

/**
 * p3b-03 — company-isolation: catalog rows of company A are invisible to
 * company B (404 on lookup, absent from lists) and cross-company FK
 * references (category/brand/UOM from another company) are rejected.
 */
describeIntegration('p3b-03 company-isolation (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  let companyBId: string;
  let categoryAId: string;
  let templateAId: string;
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const categoriesA = new CategoriesService(prisma as never, audit);
  const templatesA = new TemplatesService(prisma as never, audit);

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    const companyB = await prisma.company.create({ data: { nameFa: `شرکت بی کُر۳ ${marker}` } });
    companyBId = companyB.id;

    const categoryA = (await categoriesA.create(
      INTEGRATION_COMPANY_ID,
      { code: `ISO-${marker}`, nameFa: 'دسته ایزوله' },
      admin,
      {},
    )) as { id: string };
    categoryAId = categoryA.id;

    templateAId = (
      (await templatesA.create(
        INTEGRATION_COMPANY_ID,
        { categoryId: categoryAId, nameFa: 'محصول ایزوله', internalCode: `ISO-${marker}` },
        admin,
        {},
      )) as { id: string }
    ).id;
  });

  it('a category of company A is invisible to company B', async () => {
    const categoriesB = new CategoriesService(prisma as never, audit);
    await expect(categoriesB.getById(companyBId, categoryAId)).rejects.toMatchObject({
      statusCode: 404,
    });
    const listB = (await categoriesB.list(companyBId, {
      page: 1,
      pageSize: 100,
      active: 'any',
    } as never)) as { items: Array<{ id: string }> };
    expect(listB.items.find((c) => c.id === categoryAId)).toBeUndefined();
  });

  it('a template of company A is invisible to company B', async () => {
    await expect(templatesA.getById(companyBId, templateAId)).rejects.toMatchObject({
      statusCode: 404,
    });
    const listB = (await templatesA.list(companyBId, {
      page: 1,
      pageSize: 100,
      active: 'any',
    } as never)) as { items: Array<{ id: string }> };
    expect(listB.items.find((t) => t.id === templateAId)).toBeUndefined();
  });

  it('creating a template in company B referencing the category of company A is rejected', async () => {
    await expect(
      templatesA.create(
        companyBId,
        { categoryId: categoryAId, nameFa: 'محصول متقاطع' },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ message: 'Category not found in this company' });
  });

  it('archiving in company A does not affect the same-named category in B', async () => {
    const categoriesB = new CategoriesService(prisma as never, audit);
    const catB = (await categoriesB.create(
      companyBId,
      { code: `ISO-${marker}`, nameFa: 'دسته بی' },
      admin,
      {},
    )) as { id: string };
    await categoriesA.update(
      INTEGRATION_COMPANY_ID,
      categoryAId,
      { active: false },
      admin,
      {},
    );
    const stillActiveB = (await categoriesB.getById(companyBId, catB.id)) as { active: boolean };
    expect(stillActiveB.active).toBe(true);
    await prisma.productCategory.deleteMany({ where: { id: catB.id } });
  });

  afterAll(async () => {
    await prisma.productTemplate.deleteMany({ where: { id: templateAId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryAId } });
    await prisma.auditLog.deleteMany({
      where: { entityType: { in: ['product_category', 'product_template'] }, companyId: companyBId },
    }).catch(() => undefined);
    await prisma.auditLog.deleteMany({
      where: { entityType: { in: ['product_category', 'product_template'] }, entityId: { in: [categoryAId, templateAId] } },
    }).catch(() => undefined);
    await prisma.company.delete({ where: { id: companyBId } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
