import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  priceRequestService,
  createParty,
  createVariant,
} from '../testing/p4-fixtures';

/**
 * p4-24 create-sale-from-price-request: POST create-sale builds a
 * QUOTATION SalesDocument linked via priceRequestId + DocumentRelation
 * GENERATED_FROM (both directions), and moves the request to CONVERTED.
 * p4-25 create-purchase-from-price-request: the symmetric purchase flow —
 * a selected offer's price is copied onto the purchase line.
 */
describeIntegration('p4-24/p4-25 price request → sale/purchase (§16)', () => {
  const prisma = integrationPrisma();
  const marker = `p4m${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let requestId = '';
  let lineId = '';
  let offerId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-C`);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-S`);
    variant = await createVariant(prisma, marker);

    const prService = priceRequestService(prisma);
    const request = await prService.create(
      INTEGRATION_COMPANY_ID,
      {
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, requestedQuantity: 6 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    requestId = request.id;
    lineId = request.lines[0].id;

    const offer = await prisma.supplierOffer.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        priceRequestLineId: lineId,
        supplierPartyId: supplier.id,
        offeredPrice: 41500000,
        uomId: variant.uomId,
        createdBy: actorId,
      },
    });
    offerId = offer.id;
  });

  it('p4-24: create-sale → QUOTATION with priceRequestId + GENERATED_FROM + CONVERTED', async () => {
    const prService = priceRequestService(prisma);
    const result = await prService.createSaleFromRequest(
      INTEGRATION_COMPANY_ID,
      requestId,
      { lineSelections: [{ lineId, quantity: 6, unitPrice: 43000000 }] },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(result.status).toBe('CONVERTED');

    const sale = await prisma.salesDocument.findFirstOrThrow({ where: { priceRequestId: requestId } });
    expect(sale.status).toBe('QUOTATION');
    expect(sale.customerPartyId).toBe(customer.id);
    const saleLines = await prisma.salesLine.findMany({ where: { salesDocumentId: sale.id } });
    expect(saleLines).toHaveLength(1);
    expect(Number(saleLines[0].orderedQuantity)).toBe(6);
    expect(Number(saleLines[0].unitPrice)).toBe(43000000);

    const relations = await prisma.documentRelation.findMany({
      where: {
        OR: [
          { fromType: 'sales_document', fromId: sale.id },
          { toType: 'sales_document', toId: sale.id },
        ],
        relationType: 'GENERATED_FROM',
      },
    });
    expect(relations).toHaveLength(2); // both directions
    expect(relations.every((r) => r.companyId === INTEGRATION_COMPANY_ID)).toBe(true);
  });

  it('p4-25: create-purchase copies the selected offer’s price onto the line', async () => {
    const prService = priceRequestService(prisma);
    const result = await prService.createPurchaseFromRequest(
      INTEGRATION_COMPANY_ID,
      requestId,
      { supplierPartyId: supplier.id, lineSelections: [{ lineId, offerId }] },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(result.createdPurchaseId).toBeDefined();
    const purchase = await prisma.purchaseDocument.findFirstOrThrow({
      where: { id: result.createdPurchaseId },
      include: { lines: true },
    });
    expect(purchase.priceRequestId).toBe(requestId);
    expect(Number(purchase.lines[0].unitPrice)).toBe(41500000);
    expect(Number(purchase.lines[0].orderedQuantity)).toBe(6);

    const relations = await prisma.documentRelation.findMany({
      where: {
        OR: [
          { fromType: 'purchase_document', fromId: purchase.id },
          { toType: 'purchase_document', toId: purchase.id },
        ],
        relationType: 'GENERATED_FROM',
      },
    });
    expect(relations).toHaveLength(2);
  });

  afterAll(async () => {
    const sale = await prisma.salesDocument.findFirst({ where: { priceRequestId: requestId }, select: { id: true } });
    const purchases = await prisma.purchaseDocument.findMany({ where: { priceRequestId: requestId }, select: { id: true } });
    if (sale) {
      await prisma.salesPurchaseAllocation.deleteMany({ where: { salesLine: { salesDocumentId: sale.id } } });
      await prisma.salesDocument.deleteMany({ where: { id: sale.id } });
    }
    for (const p of purchases) {
      await prisma.salesPurchaseAllocation.deleteMany({ where: { purchaseLine: { purchaseDocumentId: p.id } } });
      await prisma.purchaseDocument.deleteMany({ where: { id: p.id } });
    }
    await prisma.priceRequest.deleteMany({ where: { id: requestId } });
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
