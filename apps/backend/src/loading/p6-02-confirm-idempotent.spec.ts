import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { loadingService, mainWarehouse, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-02 confirm-idempotent: a double confirm is a 403 LOADING_CONFIRMED, and
 * a FORCED re-run of the movement generation (the P2002 seam) creates no
 * duplicate StockMovement rows — the unique idempotency keys are the only
 * authority, so a document re-confirmation can never double-count stock.
 */
describeIntegration('p6-02 confirm-idempotent', () => {
  const prisma = integrationPrisma();
  const marker = `p6-02-${Date.now()}`;
  let actorId = '';
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    variant = await createVariant(prisma, marker);
    await mainWarehouse(prisma);
  });

  it('double confirm → LOADING_CONFIRMED; forced movement re-run → no duplicates', async () => {
    const service = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const created = await service.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variant.variantId, actualQuantity: 25 }] },
      actor,
      {},
    );
    loadingId = created.id;

    await service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    await expect(
      service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 403, message: 'LOADING_CONFIRMED' });

    // Forced re-run of the generation seam (same transaction shape as confirm).
    const main = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'MAIN' },
    });
    await prisma.$transaction(async (tx) => {
      const loading = await tx.loading.findFirstOrThrow({
        where: { id: loadingId },
        include: { lines: true },
      });
      await service.generateOutMovements(
        tx,
        { id: loading.id, companyId: loading.companyId, loadingDate: loading.loadingDate },
        loading.lines,
        main.id,
        actorId,
      );
    });

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(movements).toHaveLength(1); // P2002 swallowed — no duplicate row
    expect(movements[0].idempotencyKey).toBe(`loading:${loadingId}:line:${created.lines[0].id}`);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await disconnectIntegrationPrisma();
  });
});
