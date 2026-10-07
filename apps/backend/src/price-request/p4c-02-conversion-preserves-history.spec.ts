import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  priceRequestService,
  supplierOffersService,
  relationService,
  createParty,
  createVariant,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';

/**
 * p4c-02 conversion preserves history (Phase 4 corrective pass): converting
 * a price request only flips the status — supplier offers are NEVER deleted
 * and the converted request navigates to its generated documents via
 * getById (salesDocuments / purchaseDocuments) and DocumentRelations.
 */
describeIntegration('p4c-02 conversion keeps offers and exposes linked documents', () => {
  const prisma = integrationPrisma();
  const marker = `p4c2${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let requestId = '';
  let lineId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-C`);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-S`);
    variant = await createVariant(prisma, marker);

    const prq = priceRequestService(prisma);
    const request = await prq.create(
      INTEGRATION_COMPANY_ID,
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, requestedQuantity: 5 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    requestId = request.id;
    lineId = request.lines[0].id;

    const offers = supplierOffersService(prisma);
    await offers.addOffer(
      INTEGRATION_COMPANY_ID,
      lineId,
      { supplierPartyId: supplier.id, offeredPrice: 34250 },
      { id: actorId, username: 'admin' },
      {},
    );
  });

  it('convert flips status only: offers intact, linked-document arrays present', async () => {
    const prq = priceRequestService(prisma);

    const before = await prq.getById(INTEGRATION_COMPANY_ID, requestId);
    expect(before.status).toBe('OFFERED');
    expect(before.lines[0].offers).toHaveLength(1);

    const converted = await prq.convert(INTEGRATION_COMPANY_ID, requestId, { id: actorId, username: 'admin' }, {});
    expect(converted.status).toBe('CONVERTED');
    // History intact — offers survive conversion.
    expect(converted.lines[0].offers).toHaveLength(1);
    expect(converted.lines[0].offers[0].supplierPartyId).toBe(supplier.id);
    // Conversion-history navigation is present (empty until create-sale).
    expect(Array.isArray(converted.salesDocuments)).toBe(true);
    expect(converted.salesDocuments).toHaveLength(0);
    expect(Array.isArray(converted.purchaseDocuments)).toBe(true);
  });

  it('create-sale from the converted request links the quotation: getById array + GENERATED_FROM relation', async () => {
    const prq = priceRequestService(prisma);
    const result = await prq.createSaleFromRequest(
      INTEGRATION_COMPANY_ID,
      requestId,
      { lineSelections: [{ lineId, quantity: 5, unitPrice: 43000000 }] },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(result.status).toBe('CONVERTED');
    // Offers still intact after the full conversion flow.
    expect(result.lines[0].offers).toHaveLength(1);

    const sale = await prisma.salesDocument.findFirstOrThrow({ where: { priceRequestId: requestId } });
    expect(sale.status).toBe('QUOTATION');

    // getById exposes the generated document in the navigation array.
    const detail = await prq.getById(INTEGRATION_COMPANY_ID, requestId);
    expect(detail.salesDocuments).toHaveLength(1);
    expect(detail.salesDocuments[0].id).toBe(sale.id);
    expect(detail.salesDocuments[0].documentNumber).toBe(sale.documentNumber);
    expect(detail.salesDocuments[0].status).toBe('QUOTATION');
    expect(detail.purchaseDocuments).toHaveLength(0);

    // …and the flow is navigable through DocumentRelations too.
    const relations = relationService(prisma);
    const view = await relations.listRelations(INTEGRATION_COMPANY_ID, 'price_request', requestId);
    const group = view.relations.find(
      (g: { type: string; relationType: string }) => g.type === 'sales_document' && g.relationType === 'GENERATED_FROM',
    );
    expect(group).toBeDefined();
    expect(group!.count).toBe(1);
    expect(group!.items[0].id).toBe(sale.id);

    await cleanupSalesDocument(prisma, sale.id);
  });

  afterAll(async () => {
    await prisma.priceRequest.deleteMany({ where: { id: requestId } });
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
