import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { BrandsService } from './brands.service';
import { CategoriesService } from './categories.service';
import { TemplatesService } from './templates.service';

/**
 * c3b-09 — cross-company-brand-template blocked (live DB): a company-B
 * template can never reference a company-A brand (create or PATCH), and a
 * brand's logo attachment must belong to the same company
 * (file_attachments.company_id). FK targets resolve per-caller-company.
 */
describeIntegration('c3b-09 cross-company-brand-template (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const audit = new AuditService(prisma as never);
  const admin = { id: '', username: 'admin' };
  const brandsA = new BrandsService(prisma as never, audit);
  const categoriesA = new CategoriesService(prisma as never, audit);
  const templatesA = new TemplatesService(prisma as never, audit);

  let companyBId: string;
  let categoryAId: string;
  let categoryBId: string;
  let brandAId: string;
  let logoAAttachmentId: string;
  let blobId: string;
  let templateBId: string;

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    companyBId = (
      await prisma.company.create({ data: { nameFa: `شرکت بی c3b-09 ${marker}` } })
    ).id;
    categoryAId = (
      (await categoriesA.create(
        INTEGRATION_COMPANY_ID,
        { code: `C09-A-${marker}`, nameFa: 'دسته الف' },
        admin,
        {},
      )) as { id: string }
    ).id;
    categoryBId = (
      (await categoriesA.create(
        companyBId,
        { code: `C09-B-${marker}`, nameFa: 'دسته بی' },
        admin,
        {},
      )) as { id: string }
    ).id;
    brandAId = (
      (await brandsA.create(
        INTEGRATION_COMPANY_ID,
        { code: `B09-${marker}`, nameFa: 'برند الف' },
        admin,
        {},
      )) as { id: string }
    ).id;

    // A logo attachment owned by company A (blob row written directly — no
    // S3 involvement; the subject is the company guard on the attachment).
    blobId = (
      await prisma.fileBlob.create({
        data: {
          sha256: `c3b09-${marker}`,
          mimeType: 'image/png',
          size: 4n,
          storageKey: `blobs/test/c3b09-${marker}`,
        },
      })
    ).id;
    logoAAttachmentId = (
      await prisma.fileAttachment.create({
        data: {
          fileBlobId: blobId,
          companyId: INTEGRATION_COMPANY_ID,
          entityType: 'brand',
          entityId: brandAId,
          originalFilename: `logo-a-${marker}.png`,
        },
      })
    ).id;
  });

  it('creating a template in B with a company-A brand → ValidationError', async () => {
    await expect(
      templatesA.create(
        companyBId,
        { categoryId: categoryBId, nameFa: 'محصول بی', brandId: brandAId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: /brand not found in this company/i });
  });

  it('PATCHing a company-B template to a company-A brand → ValidationError', async () => {
    templateBId = (
      (await templatesA.create(
        companyBId,
        { categoryId: categoryBId, nameFa: 'محصول بی' },
        admin,
        {},
      )) as { id: string }
    ).id;
    const version = (
      await prisma.productTemplate.findUniqueOrThrow({
        where: { id: templateBId },
        select: { version: true },
      })
    ).version;
    await expect(
      templatesA.update(companyBId, templateBId, { brandId: brandAId, version }, admin, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: /brand not found in this company/i });
    const still = await prisma.productTemplate.findUniqueOrThrow({
      where: { id: templateBId },
      select: { brandId: true },
    });
    expect(still.brandId).toBeNull();
  });

  it("a company-A logo attachment cannot brand a company-B brand", async () => {
    await expect(
      brandsA.create(
        companyBId,
        { code: `B09-B-${marker}`, nameFa: 'برند بی', logoAttachmentId: logoAAttachmentId },
        admin,
        {},
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      message: 'Logo attachment not found in this company',
    });
    const rows = await prisma.brand.count({ where: { companyId: companyBId, code: `B09-B-${marker}` } });
    expect(rows).toBe(0);
  });

  it('the same attachment is accepted for a brand of its OWN company', async () => {
    const brand = (await brandsA.create(
      INTEGRATION_COMPANY_ID,
      { code: `B09-A2-${marker}`, nameFa: 'برند الف دو', logoAttachmentId: logoAAttachmentId },
      admin,
      {},
    )) as { id: string };
    const row = await prisma.brand.findUniqueOrThrow({
      where: { id: brand.id },
      select: { logoAttachmentId: true },
    });
    expect(row.logoAttachmentId).toBe(logoAAttachmentId);
    await prisma.brand.deleteMany({ where: { id: brand.id } });
  });

  afterAll(async () => {
    await prisma.productTemplate.deleteMany({ where: { id: templateBId } });
    await prisma.brand.deleteMany({ where: { companyId: { in: [INTEGRATION_COMPANY_ID, companyBId] }, code: { startsWith: `B09-` } } });
    await prisma.fileAttachment.deleteMany({ where: { id: logoAAttachmentId } });
    await prisma.fileBlob.deleteMany({ where: { id: blobId } });
    await prisma.productCategory.deleteMany({ where: { id: { in: [categoryAId, categoryBId] } } });
    await prisma.auditLog
      .deleteMany({
        where: {
          OR: [
            { entityType: { in: ['brand', 'product_template'] }, newValues: { path: ['nameFa'], equals: 'برند الف دو' } },
            { entityId: { in: [brandAId, templateBId] } },
          ],
        },
      })
      .catch(() => undefined);
    await prisma.company.delete({ where: { id: companyBId } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
