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

/**
 * p4-17 sale-without-price-request + p4-26 independent-sale-creation
 * (REQUIREMENTS §16): priceRequestId is a nullable REFERENCE ONLY — a sale
 * created without any price request works and keeps priceRequestId null.
 */
describeIntegration('p4-17/p4-26 sale without a price request', () => {
  const prisma = integrationPrisma();
  const marker = `p4h${Date.now()}`;
  let actorId = '';

  it('creates a quotation with no price request attached', async () => {
    actorId = await adminUserId(prisma);
    const service = salesService(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], marker);
    const variant = await createVariant(prisma, marker);

    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      {
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, quantity: 1, unitPrice: 1000 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(doc.priceRequestId).toBeNull();
    expect(doc.status).toBe('QUOTATION');
    expect(doc.documentNumber).toMatch(/^SD-\d{4}-\d{5}$/);

    await cleanupSalesDocument(prisma, doc.id);
    await prisma.party.deleteMany({ where: { id: customer.id } });
  });

  afterAll(async () => {
    await prisma.productVariant.deleteMany({ where: { sku: { startsWith: 'P4-' } } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
