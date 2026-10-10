import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId } from '../testing/p4-fixtures';
import { NormalizationService } from '../inventory/normalization.service';
import { inventoryService } from '../testing/p6-fixtures';
import { createVariantEx, seededUoms } from './g6-helpers';

/**
 * g6-06 — impossible-cross-category-rejected: WITHOUT a complete product
 * weight pair, pieces ↔ kg can NEVER convert — the normalization service
 * answers 422 UOM_CONVERSION_IMPOSSIBLE (never guesses, never approximates).
 */
describeIntegration('g6-06 impossible-cross-category-rejected', () => {
  const prisma = integrationPrisma();
  const marker = `g6-06-${Date.now()}`;
  let actorId = '';
  let variantId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
  });

  it('pcs → kg without a weight pair is impossible (normalize + convertBetween)', async () => {
    const uoms = await seededUoms(prisma);
    // NO weightPerUnit / weightUomId on this variant.
    const variant = await createVariantEx(prisma, marker, {
      defaultUomId: uoms.pcsId,
      inventoryUomId: uoms.kgId,
    });
    variantId = variant.variantId;

    const normalization = new NormalizationService(prisma as never);
    await expect(
      normalization.normalizeQuantity(INTEGRATION_COMPANY_ID, variantId, 5, uoms.pcsId),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_CONVERSION_IMPOSSIBLE' });
    await expect(
      normalization.convertBetween(INTEGRATION_COMPANY_ID, variantId, 5, uoms.pcsId, uoms.kgId),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_CONVERSION_IMPOSSIBLE' });
    // The symmetric direction is equally impossible.
    await expect(
      normalization.convertBetween(INTEGRATION_COMPANY_ID, variantId, 5, uoms.kgId, uoms.pcsId),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_CONVERSION_IMPOSSIBLE' });
  });

  it('a mismatched weight pair (weight uom in the wrong category) is impossible too', async () => {
    const uoms = await seededUoms(prisma);
    // weightPerUnit set but the weight uom is kg while the TARGET is pcs
    // (count): the bridge lands in the wrong category → impossible.
    const variant = await createVariantEx(prisma, `${marker}-b`, {
      defaultUomId: uoms.pcsId,
      inventoryUomId: uoms.pcsId,
      weightPerUnit: '2',
      weightUomId: uoms.kgId,
    });
    const normalization = new NormalizationService(prisma as never);
    await expect(
      normalization.normalizeQuantity(INTEGRATION_COMPANY_ID, variant.variantId, 5, uoms.kgId),
    ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_CONVERSION_IMPOSSIBLE' });
  });

  it('a transfer expressed in an unconvertible uom is rejected at the seam', async () => {
    const uoms = await seededUoms(prisma);
    const variant = await createVariantEx(prisma, `${marker}-c`, {
      defaultUomId: uoms.pcsId,
      inventoryUomId: uoms.kgId,
    });
    const inventory = inventoryService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const w1 = await inventory.createWarehouse(INTEGRATION_COMPANY_ID, { code: `G6A-${marker}`, nameFa: 'مبدأ' }, actor, {});
    const w2 = await inventory.createWarehouse(INTEGRATION_COMPANY_ID, { code: `G6B-${marker}`, nameFa: 'مقصد' }, actor, {});
    try {
      await expect(
        inventory.transfer(
          INTEGRATION_COMPANY_ID,
          { variantId: variant.variantId, quantity: 3, uomId: uoms.pcsId, fromWarehouseId: w1.id, toWarehouseId: w2.id },
          actor,
          {},
        ),
      ).rejects.toMatchObject({ statusCode: 422, message: 'UOM_CONVERSION_IMPOSSIBLE' });
    } finally {
      await prisma.warehouse.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: { in: [w1.id, w2.id] } } }).catch(() => undefined);
    }
    void actorId;
  });

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: { in: [variantId] } } });
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: { startsWith: `G6-${marker}` } } });
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `گیت۶ تست ${marker}` } } });
    await prisma.productCategory.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, code: { contains: marker } },
    });
    await disconnectIntegrationPrisma();
  });
});
