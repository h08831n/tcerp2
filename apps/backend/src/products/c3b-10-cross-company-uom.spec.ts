import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { TemplatesService } from './templates.service';
import { UomConversionService } from './uom-conversion.service';
import { UomsService } from './uoms.service';

/**
 * c3b-10 — cross-company-uom blocked (live DB): UOMs of company A are
 * invisible to company B everywhere they are dereferenced — template sales/
 * purchase/default UOM, variant weightUom (explicit-weight path) and the
 * conversion engine (convert + convertWithProductWeight). The positive
 * control proves the same calls succeed when everything is same-company.
 */
describeIntegration('c3b-10 cross-company-uom (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const uomsA = new UomsService(prisma as never, audit);
  const uomsB = new UomsService(prisma as never, audit);
  const templatesA = new TemplatesService(prisma as never, audit);
  const converter = new UomConversionService(prisma as never);

  const BOGUS_ATTR = '00000000-0000-4000-8000-00000000000a';
  const BOGUS_VALUE = '00000000-0000-4000-8000-00000000000b';

  let companyBId: string;
  let catAId: string;
  let kgAId: string;
  let catBId: string;
  let kgBId: string;
  let tonBId: string;
  let categoryBId: string;
  let templateBId: string;
  let variantBId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    companyBId = (
      await prisma.company.create({ data: { nameFa: `شرکت بی c3b-10 ${marker}` } })
    ).id;

    // Company A: a Weight category with kg (base) + ton.
    catAId = (
      (await uomsA.createCategory(
        INTEGRATION_COMPANY_ID,
        { code: `W-A-${marker}`, nameFa: 'وزن الف' },
        admin,
        {},
      )) as { id: string }
    ).id;
    kgAId = (
      (await uomsA.createUom(
        INTEGRATION_COMPANY_ID,
        { categoryId: catAId, nameFa: 'کیلوگرم', symbol: `kg-${marker}`, conversionRatio: '1', isBaseUnit: true },
        admin,
        {},
      )) as { id: string }
    ).id;
    await uomsA.createUom(
      INTEGRATION_COMPANY_ID,
      { categoryId: catAId, nameFa: 'تن', symbol: `ton-${marker}`, conversionRatio: '1000' },
      admin,
      {},
    );

    // Company B: its OWN Weight category with kg (base) + ton.
    catBId = (
      (await uomsB.createCategory(
        companyBId,
        { code: `W-B-${marker}`, nameFa: 'وزن بی' },
        admin,
        {},
      )) as { id: string }
    ).id;
    kgBId = (
      (await uomsB.createUom(
        companyBId,
        { categoryId: catBId, nameFa: 'کیلوگرم', symbol: `kg-${marker}`, conversionRatio: '1', isBaseUnit: true },
        admin,
        {},
      )) as { id: string }
    ).id;
    tonBId = (
      (await uomsB.createUom(
        companyBId,
        { categoryId: catBId, nameFa: 'تن', symbol: `ton-${marker}`, conversionRatio: '1000' },
        admin,
        {},
      )) as { id: string }
    ).id;

    // Category + template + variant of company B; the variant carries a
    // FOREIGN weight UOM (company A's kg) so the convertWithProductWeight
    // guard can be exercised against bad data.
    categoryBId = (
      await prisma.productCategory.create({
        data: { companyId: companyBId, code: `C10-${marker}`, nameFa: 'دسته بی' },
      })
    ).id;
    templateBId = (
      await prisma.productTemplate.create({
        data: { companyId: companyBId, categoryId: categoryBId, nameFa: 'محصول بی' },
      })
    ).id;
    variantBId = (
      await prisma.productVariant.create({
        data: {
          companyId: companyBId,
          templateId: templateBId,
          sku: `C10-${marker}`,
          nameFa: 'واریانت بی',
          combinationKey: `k-${marker}`,
          weightPerUnit: 1,
        },
      })
    ).id;
    await prisma.$executeRaw`UPDATE product_variants SET weight_uom_id = ${kgAId}::uuid WHERE id = ${variantBId}::uuid`;
  });

  it('template create in B with a company-A sales UOM → ValidationError', async () => {
    await expect(
      templatesA.create(
        companyBId,
        { categoryId: categoryBId, nameFa: 'محصول بی دو', defaultSalesUomId: kgAId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: /uom not found in this company/i });
  });

  it('variant generate in B with a company-A weightUomId → UOM_NOT_IN_COMPANY', async () => {
    await expect(
      templatesA.generateVariants(
        companyBId,
        templateBId,
        {
          combinations: [
            {
              selections: [{ attributeId: BOGUS_ATTR, valueId: BOGUS_VALUE }],
              weightPerUnit: '18.7',
              weightUomId: kgAId, // company A's kg
            },
          ],
        },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_NOT_IN_COMPANY' });
  });

  it('variant PATCH defaultUomId to a company-A UOM → ValidationError', async () => {
    const variant = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantBId } });
    await expect(
      templatesA.updateVariant(
        companyBId,
        templateBId,
        variantBId,
        { defaultUomId: kgAId, version: variant.version },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: /uom not found in this company/i });
  });

  it('conversion engine refuses company-A UOMs for a company-B caller (UOM_NOT_IN_COMPANY)', async () => {
    await expect(converter.convert(1, kgAId, kgBId, companyBId)).rejects.toMatchObject({
      statusCode: 422,
      message: 'UOM_NOT_IN_COMPANY',
    });
  });

  it('convertWithProductWeight refuses a foreign weightUom (variant of B, weight UOM of A)', async () => {
    await expect(
      converter.convertWithProductWeight(
        100,
        kgBId,
        tonBId,
        { weightPerUnit: '18.7', weightUomId: kgAId },
        companyBId,
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_NOT_IN_COMPANY' });
  });

  it('positive control: fully same-company weight path converts (100 × 18.7 kg → 1.87 ton)', async () => {
    const result = await converter.convertWithProductWeight(
      100,
      kgBId,
      tonBId,
      { weightPerUnit: '18.7', weightUomId: kgBId },
      companyBId,
    );
    // 100 pieces × 18.7 kg/piece = 1870 kg, expressed in the TARGET uom (ton)
    expect(result.value.toString()).toBe('1.87');
  });

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { id: variantBId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateBId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryBId } });
    await prisma.uom.deleteMany({ where: { categoryId: { in: [catAId, catBId] } } });
    await prisma.uomCategory.deleteMany({ where: { id: { in: [catAId, catBId] } } });
    await prisma.auditLog
      .deleteMany({
        where: {
          entityType: { in: ['uom', 'uom_category'] },
          entityId: { in: [catAId, kgAId, catBId, kgBId, tonBId] },
        },
      })
      .catch(() => undefined);
    await prisma.company.delete({ where: { id: companyBId } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
