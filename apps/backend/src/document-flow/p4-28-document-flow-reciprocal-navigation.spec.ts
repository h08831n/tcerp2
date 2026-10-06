import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  salesService,
  purchaseService,
  relationService,
  createParty,
  createVariant,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4-28 document-flow-reciprocal-navigation (REQUIREMENTS §13): from the
 * sale you see the purchase(s) and from the purchase you see the sale —
 * CREATED_FROM rows in BOTH directions, grouped counts included.
 */
describeIntegration('p4-28 reciprocal document navigation', () => {
  const prisma = integrationPrisma();
  const marker = `p4n${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let saleId = '';
  let purchaseId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-C`);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-S`);
    variant = await createVariant(prisma, marker);

    const sales = salesService(prisma);
    const purchase = purchaseService(prisma);

    const doc = await sales.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 5, unitPrice: 0 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    saleId = doc.id;

    const po = await purchase.createPurchaseFromSale(
      INTEGRATION_COMPANY_ID,
      saleId,
      { supplierPartyId: supplier.id },
      { id: actorId, username: 'admin' },
      {},
    );
    purchaseId = po.id;
  });

  it('from the sale you see the purchase (grouped, labelled)', async () => {
    const relations = relationService(prisma);
    const view = await relations.listRelations(INTEGRATION_COMPANY_ID, 'sales_document', saleId);
    const group = view.relations.find((g: { type: string; relationType: string }) => g.type === 'purchase_document' && g.relationType === 'CREATED_FROM');
    expect(group).toBeDefined();
    expect(group!.count).toBe(1);
    expect(group!.items[0].id).toBe(purchaseId);
    // Label = the purchase document number.
    const po = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(group!.items[0].label).toBe(po.documentNumber);
    expect(view.totals.purchase_document).toBe(1);
  });

  it('from the purchase you see the sale (the reverse direction)', async () => {
    const relations = relationService(prisma);
    const view = await relations.listRelations(INTEGRATION_COMPANY_ID, 'purchase_document', purchaseId);
    const group = view.relations.find((g: { type: string; relationType: string }) => g.type === 'sales_document' && g.relationType === 'CREATED_FROM');
    expect(group).toBeDefined();
    expect(group!.count).toBe(1);
    expect(group!.items[0].id).toBe(saleId);
    expect(view.totals.sales_document).toBe(1);
  });

  it('the copied purchase line matches the sale line 1:1 (variant/uom/qty) with unitPrice 0', async () => {
    const saleLine = (await prisma.salesLine.findFirstOrThrow({ where: { salesDocumentId: saleId } }));
    const poLine = (await prisma.purchaseLine.findFirstOrThrow({ where: { purchaseDocumentId: purchaseId } }));
    expect(poLine.productVariantId).toBe(saleLine.productVariantId);
    expect(poLine.uomId).toBe(saleLine.uomId);
    expect(Number(poLine.orderedQuantity)).toBe(Number(saleLine.orderedQuantity));
    expect(Number(poLine.unitPrice)).toBe(0); // buyer fills the price
    const po = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(po.status).toBe('ORDER_PLACED');
  });

  afterAll(async () => {
    await cleanupSalesDocument(prisma, saleId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
