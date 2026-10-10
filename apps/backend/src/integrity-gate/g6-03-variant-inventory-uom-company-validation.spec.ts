import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { createCompany } from '../testing/p5-fixtures';
import { TemplatesService } from '../products/templates.service';
import { AuditService } from '../audit/audit.service';
import { createVariantEx } from './g6-helpers';

/**
 * g6-03 — variant-inventory-uom-company-validation: the inventory UOM of a
 * variant must belong to the SAME company — a PATCH pointing at another
 * company's uom is a 422 UOM_NOT_IN_COMPANY; a valid same-company PATCH
 * (while no movements exist) is accepted.
 */
describeIntegration('g6-03 variant-inventory-uom-company-validation', () => {
  const prisma = integrationPrisma();
  const marker = `g6-03-${Date.now()}`;
  let actorId = '';
  let companyBId = '';
  let variantAId = '';
  let templateAId = '';
  let versionA = 1;

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const companyB = await createCompany(prisma, marker);
    companyBId = companyB.id;

    // Company A: kg-based variant (no movements yet).
    const variant = await createVariant(prisma, marker);
    variantAId = variant.variantId;
    templateAId = variant.templateId;
    const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantAId } });
    versionA = row.version;
  });

  it('cross-company inventoryUom PATCH → 422 UOM_NOT_IN_COMPANY', async () => {
    const actor = { id: actorId, username: 'admin' };
    const templates = new TemplatesService(prisma as never, new AuditService(prisma as never));

    // Company A's seeded kg uom is NOT company B's — but this PATCH runs IN
    // company B's scope against a foreign template: 404 first.
    await expect(
      templates.updateVariant(
        companyBId,
        templateAId,
        variantAId,
        { inventoryUomId: (await prisma.uom.findFirstOrThrow({ where: { companyId: INTEGRATION_COMPANY_ID, symbol: 'kg' } })).id, version: versionA } as never,
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });

    // A company-B uom target for A's variant: same-company guard fires.
    const category = await prisma.uomCategory.create({
      data: { companyId: companyBId, code: `W-${marker}`, nameFa: 'وزن' },
    });
    const bKg = await prisma.uom.create({
      data: {
        companyId: companyBId,
        categoryId: category.id,
        symbol: 'kgB',
        nameFa: 'کیلوگرم',
        conversionRatio: '1',
        isBaseUnit: true,
      },
    });
    await expect(
      templates.updateVariant(
        INTEGRATION_COMPANY_ID,
        templateAId,
        variantAId,
        { inventoryUomId: bKg.id, version: versionA } as never,
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_NOT_IN_COMPANY' });
  });

  it('a company-B variant accepts a company-B uom (no movements yet)', async () => {
    const actor = { id: actorId, username: 'admin' };
    const templates = new TemplatesService(prisma as never, new AuditService(prisma as never));

    const category = await prisma.uomCategory.findFirstOrThrow({
      where: { companyId: companyBId, code: `W-${marker}` },
    });
    const bTon = await prisma.uom.create({
      data: {
        companyId: companyBId,
        categoryId: category.id,
        symbol: 'tonB',
        nameFa: 'تن',
        conversionRatio: '1000',
        isBaseUnit: false,
      },
    });
    const variant = await createVariantEx(prisma, `${marker}-b`, {
      companyId: companyBId,
      defaultUomId: bTon.id,
      inventoryUomId: bTon.id,
    });
    // PATCH to the OTHER company-B uom (kg) — same company, no movements yet.
    const bKg = await prisma.uom.findFirstOrThrow({
      where: { companyId: companyBId, symbol: 'kgB' },
    });
    const updated = await templates.updateVariant(
      companyBId,
      variant.templateId,
      variant.variantId,
      { inventoryUomId: bKg.id, version: 1 } as never,
      actor,
      {},
    );
    expect(updated.inventoryUomId).toBe(bKg.id);
  });

  afterAll(async () => {
    // Company B wholesale.
    await prisma.stockMovement.deleteMany({ where: { companyId: companyBId } });
    await prisma.productVariant.deleteMany({ where: { companyId: companyBId } });
    await prisma.productTemplate.deleteMany({ where: { companyId: companyBId } });
    await prisma.productCategory.deleteMany({ where: { companyId: companyBId } });
    await prisma.uom.deleteMany({ where: { companyId: companyBId } });
    await prisma.uomCategory.deleteMany({ where: { companyId: companyBId } });
    await prisma.company.deleteMany({ where: { id: companyBId } }).catch(() => undefined);
    // Company A rows for this marker (no movements were created).
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantAId } });
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: templateAId } });
    await prisma.productCategory.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, code: { contains: marker } },
    });
    await disconnectIntegrationPrisma();
  });
});
