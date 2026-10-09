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
 * p6-06 over-allocation-guard: a loading allocation beyond the line's
 * remaining ordered quantity is rejected with ALLOCATION_EXCEEDS_QUANTITY —
 * both directly (11 > 10) and cumulatively across loadings (6 + 6 > 10;
 * loading allocations consume ordered quantity on BOTH sales and purchase
 * lines).
 */
describeIntegration('p6-06 over-allocation-guard', () => {
  const prisma = integrationPrisma();
  const marker = `p6-06-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let saleId = '';
  let l1Id = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
  });

  it('allocation beyond ordered (or cumulative) → ALLOCATION_EXCEEDS_QUANTITY', async () => {
    const sales = salesService(prisma);
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const scope = { userId: actorId, scope: 'ALL' as const };

    const sale = await sales.create(
      INTEGRATION_COMPANY_ID,
      scope,
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 1 }] },
      actor,
      {},
    );
    saleId = sale.id;
    const saleLineId = sale.lines[0].id;

    // Direct over-allocation: 11 > 10.
    await expect(
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          lines: [
            {
              productVariantId: variant.variantId,
              actualQuantity: 11,
              allocations: [{ salesLineId: saleLineId, allocatedQuantity: 11 }],
            },
          ],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'ALLOCATION_EXCEEDS_QUANTITY' });

    // Cumulative: a first loading of 6 is fine; a second of 6 would over-allocate.
    const l1 = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          {
            productVariantId: variant.variantId,
            actualQuantity: 6,
            allocations: [{ salesLineId: saleLineId, allocatedQuantity: 6 }],
          },
        ],
      },
      actor,
      {},
    );
    l1Id = l1.id;

    await expect(
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          lines: [
            {
              productVariantId: variant.variantId,
              actualQuantity: 6,
              allocations: [{ salesLineId: saleLineId, allocatedQuantity: 6 }],
            },
          ],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'ALLOCATION_EXCEEDS_QUANTITY' });

    // A DRAFT reservation already consumes — 4 more WOULD fit (6+4=10).
    const ok = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          {
            productVariantId: variant.variantId,
            actualQuantity: 4,
            allocations: [{ salesLineId: saleLineId, allocatedQuantity: 4 }],
          },
        ],
      },
      actor,
      {},
    );
    await cleanupLoading(prisma, ok.id);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, l1Id);
    await cleanupSalesDocument(prisma, saleId);
    await disconnectIntegrationPrisma();
  });
});
