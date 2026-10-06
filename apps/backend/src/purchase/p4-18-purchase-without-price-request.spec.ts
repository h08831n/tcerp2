import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  purchaseService,
  createParty,
  createVariant,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4-18 purchase-without-price-request + p4-27 independent-purchase-creation
 * (REQUIREMENTS §11/§16): Purchase is INDEPENDENT — creating one never
 * requires a price request; priceRequestId stays null.
 */
describeIntegration('p4-18/p4-27 purchase without a price request', () => {
  const prisma = integrationPrisma();
  const marker = `p4i${Date.now()}`;
  let actorId = '';

  it('creates a purchase with no price request attached', async () => {
    actorId = await adminUserId(prisma);
    const service = purchaseService(prisma);
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    const variant = await createVariant(prisma, marker);

    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [{ productVariantId: variant.variantId, quantity: 7, unitPrice: 250000 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(doc.priceRequestId).toBeNull();
    expect(doc.status).toBe('DRAFT');
    expect(doc.documentNumber).toMatch(/^PO-\d{4}-\d{5}$/);

    await cleanupPurchaseDocument(prisma, doc.id);
    await prisma.party.deleteMany({ where: { id: supplier.id } });
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
