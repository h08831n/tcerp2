import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  salesService,
  createParty,
  createVariant,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-07 variant-mismatch-guard: a loading allocation referencing a
 * sales/purchase line with a DIFFERENT productVariantId is rejected with
 * ALLOCATION_VARIANT_MISMATCH.
 */
describeIntegration('p6-07 variant-mismatch-guard', () => {
  const prisma = integrationPrisma();
  const marker = `p6-07-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variantA = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let variantB = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let saleId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variantA = await createVariant(prisma, `${marker}-a`);
    variantB = await createVariant(prisma, `${marker}-b`);
  });

  it('allocation to a different-variant line → ALLOCATION_VARIANT_MISMATCH', async () => {
    const sales = salesService(prisma);
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const scope = { userId: actorId, scope: 'ALL' as const };

    // Sale line carries variant B; the loading line carries variant A.
    const sale = await sales.create(
      INTEGRATION_COMPANY_ID,
      scope,
      { customerPartyId: customer.id, lines: [{ productVariantId: variantB.variantId, quantity: 5, unitPrice: 1 }] },
      actor,
      {},
    );
    saleId = sale.id;

    await expect(
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          lines: [
            {
              productVariantId: variantA.variantId,
              actualQuantity: 5,
              allocations: [{ salesLineId: sale.lines[0].id, allocatedQuantity: 5 }],
            },
          ],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'ALLOCATION_VARIANT_MISMATCH' });
  });

  afterAll(async () => {
    await cleanupSalesDocument(prisma, saleId);
    await disconnectIntegrationPrisma();
  });
});
