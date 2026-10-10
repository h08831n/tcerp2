import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * g6-16 — confirmed-loading-edit-blocked: a CONFIRMED loading is immutable —
 * PATCH → 422 LOADING_NOT_DRAFT, DELETE/cancel → 403 LOADING_CONFIRMED (kept
 * passing under the new location-based model).
 */
describeIntegration('g6-16 confirmed-loading-edit-blocked', () => {
  const prisma = integrationPrisma();
  const marker = `g6-16-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let loadingId = '';

  it('update/cancel/delete on CONFIRMED are rejected', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const variant = await createVariant(prisma, marker);
    variantId = variant.variantId;

    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variantId, actualQuantity: 3 }] },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    await expect(
      loading.update(
        INTEGRATION_COMPANY_ID,
        loadingId,
        { notes: 'should not apply' } as never,
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'LOADING_NOT_DRAFT' });

    await expect(
      loading.cancel(INTEGRATION_COMPANY_ID, loadingId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 403, message: 'LOADING_CONFIRMED' });

    await expect(
      loading.delete(INTEGRATION_COMPANY_ID, loadingId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 403, message: 'LOADING_CONFIRMED' });

    // The notes were NOT applied.
    const row = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(row.notes).toBeNull();
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `میلگرد تست ${marker}` } },
    }).catch(() => undefined);
    // The P4TEST category is a shared fixture — deliberately NOT deleted.
    await disconnectIntegrationPrisma();
  });
});
