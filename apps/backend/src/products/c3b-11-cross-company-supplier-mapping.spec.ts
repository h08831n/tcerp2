import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from './categories.service';
import { SupplierMappingsService } from './supplier-mappings.service';
import { TemplatesService } from './templates.service';

/**
 * c3b-11 — cross-company-supplier-mapping blocked (live DB): every FK target
 * of a supplier mapping — the supplier party AND the level target (variant /
 * template / category) — must exist in the mapping's own company. A
 * company-B mapping can never hang off company-A rows.
 */
describeIntegration('c3b-11 cross-company-supplier-mapping (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const categoriesA = new CategoriesService(prisma as never, audit);
  const templatesA = new TemplatesService(prisma as never, audit);
  const mappings = new SupplierMappingsService(prisma as never, audit);

  let companyBId: string;
  let categoryAId: string;
  let templateAId: string;
  let variantAId: string;
  let partyAId: string;
  let partyBId: string;
  let categoryBId: string;
  let templateBId: string;
  let mappingId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    companyBId = (
      await prisma.company.create({ data: { nameFa: `شرکت بی c3b-11 ${marker}` } })
    ).id;

    categoryAId = (
      (await categoriesA.create(
        INTEGRATION_COMPANY_ID,
        { code: `C11-A-${marker}`, nameFa: 'دسته الف' },
        admin,
        {},
      )) as { id: string }
    ).id;
    templateAId = (
      (await templatesA.create(
        INTEGRATION_COMPANY_ID,
        { categoryId: categoryAId, nameFa: 'محصول الف', internalCode: `C11-${marker}` },
        admin,
        {},
      )) as { id: string }
    ).id;
    variantAId = (
      await prisma.productVariant.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          templateId: templateAId,
          sku: `C11-${marker}`,
          nameFa: 'واریانت الف',
          combinationKey: `k11-${marker}`,
        },
      })
    ).id;
    partyAId = (
      await prisma.party.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          type: 'COMPANY',
          nameFa: `تامین‌الف ${marker}`,
          roles: { create: [{ role: 'SUPPLIER' }] },
        },
      })
    ).id;
    partyBId = (
      await prisma.party.create({
        data: {
          companyId: companyBId,
          type: 'COMPANY',
          nameFa: `تامین‌بی ${marker}`,
          roles: { create: [{ role: 'SUPPLIER' }] },
        },
      })
    ).id;
    categoryBId = (
      (await categoriesA.create(
        companyBId,
        { code: `C11-B-${marker}`, nameFa: 'دسته بی' },
        admin,
        {},
      )) as { id: string }
    ).id;
    templateBId = (
      (await templatesA.create(
        companyBId,
        { categoryId: categoryBId, nameFa: 'محصول بی' },
        admin,
        {},
      )) as { id: string }
    ).id;
  });

  it('a company-A supplier party cannot back a company-B mapping', async () => {
    await expect(
      mappings.create(
        companyBId,
        { supplierPartyId: partyAId, mappingLevel: 'TEMPLATE', productTemplateId: templateBId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Supplier party not found in this company',
    });
  });

  it('a company-B supplier cannot target a company-A template', async () => {
    await expect(
      mappings.create(
        companyBId,
        { supplierPartyId: partyBId, mappingLevel: 'TEMPLATE', productTemplateId: templateAId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Product template not found in this company',
    });
  });

  it('a company-B supplier cannot target a company-A variant', async () => {
    await expect(
      mappings.create(
        companyBId,
        { supplierPartyId: partyBId, mappingLevel: 'VARIANT', productVariantId: variantAId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Product variant not found in this company',
    });
  });

  it('a company-A category cannot be a company-B mapping target', async () => {
    await expect(
      mappings.create(
        companyBId,
        { supplierPartyId: partyBId, mappingLevel: 'CATEGORY', categoryId: categoryAId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Product category not found in this company',
    });
  });

  it('positive control: same-company supplier + template mapping is created', async () => {
    const row = (await mappings.create(
      companyBId,
      { supplierPartyId: partyBId, mappingLevel: 'TEMPLATE', productTemplateId: templateBId },
      admin,
      {},
    )) as { id: string; companyId: string };
    expect(row.companyId).toBe(companyBId);
    mappingId = row.id;
  });

  afterAll(async () => {
    await prisma.supplierProduct.deleteMany({ where: { id: mappingId } });
    await prisma.partyRole.deleteMany({ where: { partyId: { in: [partyAId, partyBId] } } });
    await prisma.party.deleteMany({ where: { id: { in: [partyAId, partyBId] } } });
    await prisma.productVariant.deleteMany({ where: { id: variantAId } });
    await prisma.productTemplate.deleteMany({ where: { id: { in: [templateAId, templateBId] } } });
    await prisma.productCategory.deleteMany({ where: { id: { in: [categoryAId, categoryBId] } } });
    await prisma.auditLog
      .deleteMany({
        where: {
          OR: [
            { entityId: { in: [templateAId, templateBId, categoryAId, categoryBId, mappingId, variantAId] } },
            { entityType: 'supplier_product', newValues: { path: ['supplierPartyId'], equals: partyBId } },
          ],
        },
      })
      .catch(() => undefined);
    await prisma.company.delete({ where: { id: companyBId } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
