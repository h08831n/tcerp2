import { PrismaClient } from '@prisma/client';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { inventoryService, loadingService, mainWarehouse, cleanupLoading, stockQuery, movementQuery, loadingQuery } from '../testing/p6-fixtures';

/**
 * p6-15 restart-persistence: a BRAND-NEW PrismaClient (fresh "process")
 * reads the confirmed loadings, movements and computed stock — everything
 * survives a restart because it lives in Postgres.
 */
describeIntegration('p6-15 restart-persistence', () => {
  const prisma = integrationPrisma();
  const marker = `p6-15-${Date.now()}`;
  let actorId = '';
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  it('a fresh client sees loadings, movements and computed stock', async () => {
    actorId = await adminUserId(prisma);
    variant = await createVariant(prisma, marker);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);
    const main = await mainWarehouse(prisma);

    const actor = { id: actorId, username: 'admin' };
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 15 }],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    // Simulated restart: an entirely new client + new service instances.
    const freshClient = new PrismaClient();
    try {
      const persisted = await freshClient.loading.findUniqueOrThrow({
        where: { id: loadingId },
        include: { lines: true },
      });
      expect(persisted.status).toBe('CONFIRMED');
      expect(persisted.lines).toHaveLength(1);

      const freshInventory = inventoryService(freshClient);
      const movements = await freshInventory.movements(
        INTEGRATION_COMPANY_ID,
        movementQuery({ variantId: variant.variantId }),
      );
      expect(movements.items).toHaveLength(1);
      expect((movements.items[0] as { direction: string }).direction).toBe('OUT');

      const stock = await freshInventory.stock(
        INTEGRATION_COMPANY_ID,
        stockQuery({ variantId: variant.variantId }),
      );
      const stockRow = stock.items[0] as { stock: unknown; negative: boolean };
      expect(Number(stockRow.stock)).toBe(-15); // only the OUT exists for this variant
      expect(stockRow.negative).toBe(true);

      const list = await loadingService(freshClient).list(
        INTEGRATION_COMPANY_ID,
        { userId: actorId, scopeAll: true },
        loadingQuery({ status: 'CONFIRMED' }),
      );
      expect((list.items as { id: string }[]).some((l) => l.id === loadingId)).toBe(true);
    } finally {
      await freshClient.$disconnect();
    }
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await disconnectIntegrationPrisma();
  });
});
