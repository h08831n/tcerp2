import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty } from '../testing/p4-fixtures';
import { loadingService, inventoryService, stockQuery, cleanupLoading } from '../testing/p6-fixtures';
import {
  createVariantEx,
  seededUoms,
  ensureMainWarehouse,
  cleanupPartyLocations,
  supplierLocationCode,
} from './g6-helpers';

/**
 * g6-11 — supplier-warehouse-increases-internal: the SUPPLIER_TO_WAREHOUSE
 * route receives goods INTO the warehouse: one IN movement
 * SUPPLIER(party) → INTERNAL(LOC-MAIN), +quantity on the company total AND
 * on the per-warehouse inbound legs.
 */
describeIntegration('g6-11 supplier-warehouse-increases-internal', () => {
  const prisma = integrationPrisma();
  const marker = `g6-11-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let loadingId = '';

  it('SUPPLIER_TO_WAREHOUSE confirm → IN movement, internal stock up', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    supplierId = supplier.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    const main = await ensureMainWarehouse(prisma);

    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'SUPPLIER_TO_WAREHOUSE',
        warehouseId: main.id,
        lines: [{ productVariantId: variantId, actualQuantity: 40 }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const movement = await prisma.stockMovement.findFirstOrThrow({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(movement.direction).toBe('IN');
    expect(movement.warehouseId).toBe(main.id);
    // No purchase allocation → the DEFAULT supplier location (Integrity
    // Gate #10: SUPPLIER(purchase supplier or default)).
    const supplierLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'SUPPLIER-DEFAULT' },
    });
    const internal = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `LOC-${main.code}` },
    });
    expect(movement.sourceLocationId).toBe(supplierLocation.id);
    expect(movement.destinationLocationId).toBe(internal.id);

    const inventory = inventoryService(prisma);
    const stock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId }));
    expect(Number((stock.items[0] as { stock: { toString(): string } }).stock)).toBe(40);
    const perWarehouse = await inventory.stock(
      INTEGRATION_COMPANY_ID,
      stockQuery({ variantId, warehouseId: main.id }),
    );
    expect(Number((perWarehouse.items[0] as { stock: { toString(): string } }).stock)).toBe(40);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    await cleanupPartyLocations(prisma, INTEGRATION_COMPANY_ID, [supplierId].filter(Boolean));
    await disconnectIntegrationPrisma();
  });
});
