import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariant } from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * g6-19 — reversal-requires-reason: POST /api/loadings/:id/reverse without a
 * reason (empty/whitespace) is a 422 REVERSAL_REASON_REQUIRED — nothing is
 * written, the loading stays CONFIRMED.
 */
describeIntegration('g6-19 reversal-requires-reason', () => {
  const prisma = integrationPrisma();
  const marker = `g6-19-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let loadingId = '';

  it('empty/whitespace reason → 422, status untouched', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const variant = await createVariant(prisma, marker);
    variantId = variant.variantId;

    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variantId, actualQuantity: 2 }] },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    await expect(
      loading.reverse(INTEGRATION_COMPANY_ID, loadingId, { reason: '' }, actor, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: 'REVERSAL_REASON_REQUIRED' });
    await expect(
      loading.reverse(INTEGRATION_COMPANY_ID, loadingId, { reason: '   ' }, actor, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: 'REVERSAL_REASON_REQUIRED' });
    await expect(
      loading.reverse(INTEGRATION_COMPANY_ID, loadingId, {} as never, actor, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: 'REVERSAL_REASON_REQUIRED' });

    const row = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(row.status).toBe('CONFIRMED');
    expect(row.reversalReason).toBeNull();
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `میلگرد تست ${marker}` } },
    }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
