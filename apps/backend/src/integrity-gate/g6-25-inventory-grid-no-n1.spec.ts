import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { inventoryService, loadingService, stockQuery, cleanupLoading } from '../testing/p6-fixtures';

/**
 * g6-25 — inventory-grid-no-n1: the stock grid is ONE aggregate round trip —
 `stock()` (company-wide AND per-warehouse) issues exactly ONE raw query (no
 per-row follow-ups), regardless of how many variants the filter matches.
 */
describeIntegration('g6-25 inventory-grid-no-n1', () => {
  const prisma = integrationPrisma();
  const marker = `g6-25-${Date.now()}`;
  let actorId = '';
  const variantIds: string[] = [];
  let loadingId = '';

  it('stock() costs exactly ONE query for a multi-variant grid', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const inventory = inventoryService(prisma);

    // Three variants moving in one loading → 3 grid rows to render.
    for (let i = 0; i < 3; i += 1) {
      const variant = await createVariant(prisma, `${marker}-${i}`);
      variantIds.push(variant.variantId);
    }
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: variantIds.map((productVariantId) => ({ productVariantId, actualQuantity: 5 })),
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const spy = jest.spyOn(prisma, '$queryRaw');
    try {
      const companyWide = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery());
      expect(companyWide.items.length).toBeGreaterThanOrEqual(3);
      expect(spy).toHaveBeenCalledTimes(1); // ONE aggregate query — no N+1

      spy.mockClear();
      const anyWarehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: INTEGRATION_COMPANY_ID } });
      const perWarehouse = await inventory.stock(
        INTEGRATION_COMPANY_ID,
        stockQuery({ warehouseId: anyWarehouse.id }),
      );
      expect(perWarehouse.items.length).toBeGreaterThanOrEqual(3);
      expect(spy).toHaveBeenCalledTimes(1); // same for the warehouse filter

      spy.mockClear();
      const filtered = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ search: 'never-matches-g6-25' }));
      expect(filtered.total).toBe(0);
      expect(spy).toHaveBeenCalledTimes(1); // and for the empty result
    } finally {
      spy.mockRestore();
    }
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    for (const variantId of variantIds) {
      await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } }).catch(() => undefined);
    }
    await prisma.productTemplate.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `میلگرد تست ${marker}` } },
    }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
