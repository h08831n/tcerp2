import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { calcLineTotals } from '../common/utils/money';
import {
  adminUserId,
  salesService,
  createParty,
  createVariant,
  createTaxDefinition,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';

/**
 * p4-07 sales-line-decimal-totals — EXACT Decimal math (Prisma.Decimal):
 *   48.5 × 30,000,000 = 1,455,000,000 (subtotal)
 *   − 500,000 discount            → 1,454,500,000
 *   + 9% tax                      → 130,905,000
 *   lineTotal                     → 1,585,405,000
 * The stored line (Decimal(20,4) columns) must match exactly.
 */
describeIntegration('p4-07 sales-line-decimal-totals', () => {
  const prisma = integrationPrisma();
  const marker = `p4c${Date.now()}`;

  it('pure math: 48.5 × 30,000,000 − 500,000 + 9% is exact', () => {
    const totals = calcLineTotals({ quantity: 48.5, unitPrice: 30000000, discountAmount: 500000, taxRate: 9 });
    expect(totals.subtotal.toFixed(4)).toBe('1455000000.0000');
    expect(totals.taxAmount.toFixed(4)).toBe('130905000.0000');
    expect(totals.lineTotal.toFixed(4)).toBe('1585405000.0000');
  });

  it('the persisted sales line stores the exact totals', async () => {
    const actorId = await adminUserId(prisma);
    const service = salesService(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], marker);
    const variant = await createVariant(prisma, marker);
    const tax = await createTaxDefinition(prisma, marker);

    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      {
        customerPartyId: customer.id,
        lines: [
          {
            productVariantId: variant.variantId,
            quantity: 48.5,
            unitPrice: 30000000,
            discountAmount: 500000,
            taxDefinitionId: tax.id,
          },
        ],
      },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(doc.lines).toHaveLength(1);
    const line = doc.lines[0];
    expect(line.subtotal.toFixed(4)).toBe('1455000000.0000');
    expect(line.discountAmount.toFixed(4)).toBe('500000.0000');
    expect(line.taxAmount.toFixed(4)).toBe('130905000.0000');
    expect(line.lineTotal.toFixed(4)).toBe('1585405000.0000');
    // Tax rate snapshot from the TaxDefinition at line creation.
    expect(line.taxRateSnapshot!.toFixed(2)).toBe('9.00');

    // Document totals = sums of the lines (server-computed).
    expect(doc.total.toFixed(4)).toBe('1585405000.0000');

    await cleanupSalesDocument(prisma, doc.id);
    await prisma.party.deleteMany({ where: { id: customer.id } });
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
