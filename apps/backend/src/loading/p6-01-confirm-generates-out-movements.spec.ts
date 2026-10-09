import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { loadingService, mainWarehouse, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-01 loading-confirm-generates-out-movements: confirming a loading with 2
 * lines generates exactly 2 OUT StockMovement rows — one per line — with the
 * `loading:{loadingId}:line:{lineId}` idempotency keys, the line's quantity /
 * uom, and the company DEFAULT warehouse when the loading has none.
 */
describeIntegration('p6-01 loading-confirm-generates-out-movements', () => {
  const prisma = integrationPrisma();
  const marker = `p6-01-${Date.now()}`;
  let actorId = '';
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    variant = await createVariant(prisma, marker);
    await mainWarehouse(prisma);
  });

  it('confirm generates one OUT movement per line (default warehouse)', async () => {
    const service = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const created = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          { productVariantId: variant.variantId, actualQuantity: 100 },
          { productVariantId: variant.variantId, actualQuantity: 50 },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;

    const confirmed = await service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    expect(confirmed.status).toBe('CONFIRMED');

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
      orderBy: { quantity: 'desc' },
    });
    expect(movements).toHaveLength(2);

    const lineIds = created.lines.map((line: { id: string }) => line.id);
    const main = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'MAIN' },
    });

    movements.forEach((movement) => {
      expect(movement.direction).toBe('OUT');
      expect(movement.warehouseId).toBe(main.id); // null loading.warehouseId → company default
      expect(movement.companyId).toBe(INTEGRATION_COMPANY_ID);
      expect(movement.movementDate.toISOString()).toBe(created.loadingDate.toISOString());
      expect(lineIds).toContain(
        movement.idempotencyKey.replace(`loading:${loadingId}:line:`, ''),
      );
    });
    const quantities = movements.map((m) => Number(m.quantity)).sort((a, b) => b - a);
    expect(quantities).toEqual([100, 50]);
    const uoms = new Set(movements.map((m) => m.uomId));
    expect(uoms).toContain(variant.uomId); // line uom fallback = variant default (kg)
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await disconnectIntegrationPrisma();
  });
});
