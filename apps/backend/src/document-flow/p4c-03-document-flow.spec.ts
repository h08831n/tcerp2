import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  salesService,
  purchaseService,
  priceRequestService,
  relationService,
  createParty,
  createVariant,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4c-03 document flow (Phase 4 corrective pass): the relation view of a
 * sale shows its purchase (CREATED_FROM), a `loading` placeholder group
 * (count 0 — Phase 6 slot so the UI stays stable), and — when the sale
 * carries price_request_id — a derived price_request GENERATED_FROM group;
 * the purchase reciprocally shows the sale.
 */
describeIntegration('p4c-03 document flow: purchase + loading placeholder + derived price request', () => {
  const prisma = integrationPrisma();
  const marker = `p4c3${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let saleId = '';
  let purchaseId = '';
  let requestId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-C`);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-S`);
    variant = await createVariant(prisma, marker);

    const doc = await salesService(prisma).create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 2, unitPrice: 5000 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    saleId = doc.id;

    const po = await purchaseService(prisma).createPurchaseFromSale(
      INTEGRATION_COMPANY_ID,
      saleId,
      { supplierPartyId: supplier.id },
      { id: actorId, username: 'admin' },
      {},
    );
    purchaseId = po.id;
  });

  it('sale relations: purchase_document group AND loading placeholder (count 0)', async () => {
    const view = await relationService(prisma).listRelations(INTEGRATION_COMPANY_ID, 'sales_document', saleId);

    const purchaseGroup = view.relations.find((g: { type: string }) => g.type === 'purchase_document');
    expect(purchaseGroup).toBeDefined();
    expect(purchaseGroup!.count).toBe(1);
    expect(purchaseGroup!.items[0].id).toBe(purchaseId);

    // Future Loadings slot (Phase 6) — present with an EMPTY group.
    const loadingGroup = view.relations.find((g: { type: string }) => g.type === 'loading');
    expect(loadingGroup).toBeDefined();
    expect(loadingGroup!.count).toBe(0);
    expect(loadingGroup!.items).toHaveLength(0);
  });

  it('purchase relations: the sale is visible in the reverse direction', async () => {
    const view = await relationService(prisma).listRelations(INTEGRATION_COMPANY_ID, 'purchase_document', purchaseId);
    const salesGroup = view.relations.find((g: { type: string }) => g.type === 'sales_document');
    expect(salesGroup).toBeDefined();
    expect(salesGroup!.count).toBe(1);
    expect(salesGroup!.items[0].id).toBe(saleId);
  });

  it('a sale with price_request_id derives a price_request GENERATED_FROM group', async () => {
    // The sale was NOT created from a request — wire the FK directly (the
    // relation layer reads sales_documents.price_request_id, not only
    // DocumentRelation rows).
    const prq = priceRequestService(prisma);
    const request = await prq.create(
      INTEGRATION_COMPANY_ID,
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, requestedQuantity: 2 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    requestId = request.id;
    await prisma.salesDocument.update({ where: { id: saleId }, data: { priceRequestId: requestId } });

    const view = await relationService(prisma).listRelations(INTEGRATION_COMPANY_ID, 'sales_document', saleId);
    const prGroup = view.relations.find(
      (g: { type: string; relationType: string }) => g.type === 'price_request' && g.relationType === 'GENERATED_FROM',
    );
    expect(prGroup).toBeDefined();
    expect(prGroup!.count).toBe(1);
    expect(prGroup!.items[0].id).toBe(requestId);
    const stored = await prisma.priceRequest.findUniqueOrThrow({ where: { id: requestId }, select: { requestNumber: true } });
    expect(prGroup!.items[0].label).toBe(stored.requestNumber);
  });

  afterAll(async () => {
    await cleanupSalesDocument(prisma, saleId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.priceRequest.deleteMany({ where: { id: requestId } });
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
