import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import {
  inventoryService,
  loadingService,
  mainWarehouse,
  cleanupLoading,
} from '../testing/p6-fixtures';

/**
 * p6-14 warehouse-default-resolution: a loading with NO warehouse generates
 * its OUT movements in the company DEFAULT warehouse (MAIN); an explicit
 * warehouseId is honored. Warehouse defaults follow the UOM base-unit
 * precedent: promoting a second default is a 409, set-default flips.
 */
describeIntegration('p6-14 warehouse-default-resolution', () => {
  const prisma = integrationPrisma();
  const marker = `p6-14-${Date.now()}`;
  let actorId = '';
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingAId = '';
  let loadingBId = '';
  let extraWarehouseId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    variant = await createVariant(prisma, marker);
    await mainWarehouse(prisma);
  });

  it('no warehouseId → default used; explicit warehouse honored; default uniqueness enforced', async () => {
    const inventory = inventoryService(prisma);
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const main = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'MAIN' },
    });

    // (a) No warehouseId → default MAIN.
    const a = await loading.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variant.variantId, actualQuantity: 1 }] },
      actor,
      {},
    );
    loadingAId = a.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingAId, actor, {});
    const aMovements = await prisma.stockMovement.findMany({ where: { sourceEntityId: loadingAId } });
    expect(aMovements).toHaveLength(1);
    expect(aMovements[0].warehouseId).toBe(main.id);

    // (b) Explicit warehouse honored.
    const extra = await inventory.createWarehouse(
      INTEGRATION_COMPANY_ID,
      { code: `P6W-${marker}`, nameFa: 'انبار تست ۶-۱۴' },
      actor,
      {},
    );
    extraWarehouseId = extra.id;
    const b = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        warehouseId: extraWarehouseId,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 2 }],
      },
      actor,
      {},
    );
    loadingBId = b.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingBId, actor, {});
    const bMovements = await prisma.stockMovement.findMany({ where: { sourceEntityId: loadingBId } });
    expect(bMovements).toHaveLength(1);
    expect(bMovements[0].warehouseId).toBe(extraWarehouseId);

    // (c) At-most-one default (UOM base precedent): MAIN is still default →
    // creating another default is a 409 WAREHOUSE_DEFAULT_EXISTS.
    await expect(
      inventory.createWarehouse(
        INTEGRATION_COMPANY_ID,
        { code: `P6W2-${marker}`, nameFa: 'انبار دوم', isDefault: true },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WAREHOUSE_DEFAULT_EXISTS' });

    // (d) set-default FLIPS: extra becomes the only default.
    await inventory.setDefaultWarehouse(INTEGRATION_COMPANY_ID, extraWarehouseId, actor, {});
    const defaults = await prisma.warehouse.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(extraWarehouseId);

    // Restore MAIN as default for the shared integration company.
    await inventory.setDefaultWarehouse(INTEGRATION_COMPANY_ID, main.id, actor, {});

    // (e) A warehouse with movements cannot be deleted.
    await expect(
      inventory.deleteWarehouse(INTEGRATION_COMPANY_ID, extraWarehouseId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WAREHOUSE_IN_USE' });
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingAId);
    await cleanupLoading(prisma, loadingBId);
    if (extraWarehouseId) {
      await prisma.warehouse.deleteMany({ where: { id: extraWarehouseId } }).catch(() => undefined);
    }
    await disconnectIntegrationPrisma();
  });
});
