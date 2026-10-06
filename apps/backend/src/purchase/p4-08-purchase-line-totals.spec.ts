import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { calcPurchaseLineTotal } from '../common/utils/money';
import {
  adminUserId,
  purchaseService,
  createParty,
  createVariant,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4-08 purchase-line-totals: lineTotal = quantity × unitPrice, exact
 * Decimal math, and document totals = Σ lineTotal (server-authoritative).
 */
describeIntegration('p4-08 purchase-line-totals', () => {
  const prisma = integrationPrisma();
  const marker = `p4d${Date.now()}`;

  it('pure math: 12.75 × 41,250,000 is exact', () => {
    expect(calcPurchaseLineTotal({ quantity: 12.75, unitPrice: 41250000 }).toFixed(4)).toBe('525937500.0000');
  });

  it('the persisted purchase line + document totals are exact', async () => {
    const actorId = await adminUserId(prisma);
    const service = purchaseService(prisma);
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    const v1 = await createVariant(prisma, `${marker}-a`);
    const v2 = await createVariant(prisma, `${marker}-b`);

    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [
          { productVariantId: v1.variantId, quantity: 12.75, unitPrice: 41250000 },
          { productVariantId: v2.variantId, quantity: 3, unitPrice: 10000000.5 },
        ],
      },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(doc.lines[0].lineTotal.toFixed(4)).toBe('525937500.0000');
    expect(doc.lines[1].lineTotal.toFixed(4)).toBe('30000001.5000');
    expect(doc.subtotal.toFixed(4)).toBe('555937501.5000');
    expect(doc.total.toFixed(4)).toBe('555937501.5000');

    await cleanupPurchaseDocument(prisma, doc.id);
    await prisma.party.deleteMany({ where: { id: supplier.id } });
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
