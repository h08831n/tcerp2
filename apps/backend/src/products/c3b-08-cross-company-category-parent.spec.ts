import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from './categories.service';

/**
 * c3b-08 — cross-company-category-parent blocked (live DB): a category of
 * company A can never become the parent of a category in company B — on
 * create AND on PATCH. The FK target must exist in the caller's company
 * (assertSameCompany → 422), so cross-company hierarchies are impossible.
 */
describeIntegration('c3b-08 cross-company-category-parent (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const categoriesA = new CategoriesService(prisma as never, audit);

  let companyBId: string;
  let parentAId: string;
  let childBId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    companyBId = (
      await prisma.company.create({ data: { nameFa: `شرکت بی c3b-08 ${marker}` } })
    ).id;
    parentAId = (
      (await categoriesA.create(
        INTEGRATION_COMPANY_ID,
        { code: `C08-A-${marker}`, nameFa: 'والد شرکت الف' },
        admin,
        {},
      )) as { id: string }
    ).id;
  });

  it('creating a category in B with a company-A parent → ValidationError', async () => {
    await expect(
      categoriesA.create(
        companyBId,
        { code: `C08-B-${marker}`, nameFa: 'فرزند شرکت بی', parentId: parentAId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Parent category not found in this company',
    });
    // nothing was created
    const rows = await prisma.productCategory.count({
      where: { companyId: companyBId, code: `C08-B-${marker}` },
    });
    expect(rows).toBe(0);
  });

  it('PATCHing a company-B category to a company-A parent → ValidationError', async () => {
    childBId = (
      (await categoriesA.create(
        companyBId,
        { code: `C08-B-${marker}`, nameFa: 'فرزند شرکت بی' },
        admin,
        {},
      )) as { id: string }
    ).id;
    await expect(
      categoriesA.update(companyBId, childBId, { parentId: parentAId }, admin, {}),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Parent category not found in this company',
    });
    const stillRoot = (await prisma.productCategory.findUniqueOrThrow({
      where: { id: childBId },
      select: { parentId: true },
    })) as { parentId: string | null };
    expect(stillRoot.parentId).toBeNull();
  });

  it('the same parent works inside company A (the guard is about the company, not the id)', async () => {
    const sibling = (await categoriesA.create(
      INTEGRATION_COMPANY_ID,
      { code: `C08-A2-${marker}`, nameFa: 'فرزند شرکت الف', parentId: parentAId },
      admin,
      {},
    )) as { id: string };
    const row = await prisma.productCategory.findUniqueOrThrow({
      where: { id: sibling.id },
      select: { parentId: true },
    });
    expect(row.parentId).toBe(parentAId);
    await prisma.productCategory.deleteMany({ where: { id: sibling.id } });
  });

  afterAll(async () => {
    await prisma.productCategory.deleteMany({ where: { id: { in: [childBId, parentAId] } } });
    await prisma.auditLog
      .deleteMany({ where: { entityType: 'product_category', entityId: { in: [childBId, parentAId] } } })
      .catch(() => undefined);
    await prisma.company.delete({ where: { id: companyBId } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
