import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  salesService,
  purchaseService,
  createParty,
  createVariant,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';
import { loadingService, relationService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-05 allocation-links-sale-and-purchase: ONE loading allocated to BOTH a
 * sales line and a purchase line updates `operationalLoadedAmount` on BOTH
 * documents with exact Decimal math (allocatedQuantity × line.unitPrice) and
 * recomputes the document status — PARTIALLY_LOADED after a partial load,
 * COMPLETED when every line's loaded quantity ≥ ordered.
 */
describeIntegration('p6-05 allocation-links-sale-and-purchase', () => {
  const prisma = integrationPrisma();
  const marker = `p6-05-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let saleId = '';
  let purchaseId = '';
  const loadingIds: string[] = [];

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    supplier = await createParty(prisma, ['SUPPLIER'], marker);
    variant = await createVariant(prisma, marker);
  });

  it('allocations drive operationalLoadedAmount + PARTIALLY_LOADED → COMPLETED', async () => {
    const sales = salesService(prisma);
    const purchase = purchaseService(prisma);
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const scope = { userId: actorId, scope: 'ALL' as const };

    // Sale: 10 kg @ 100.5 (activated to SALES_ORDER).
    const sale = await sales.create(
      INTEGRATION_COMPANY_ID,
      scope,
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 100.5 }] },
      actor,
      {},
    );
    saleId = sale.id;
    await sales.confirm(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});
    await sales.activate(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});
    const saleLineId = sale.lines[0].id;

    // Purchase: 10 kg @ 50, placed (ORDER_PLACED).
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 50 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    const purchaseLineId = po.lines[0].id;

    // Loading #1 allocates 4 to each side.
    const l1 = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          {
            productVariantId: variant.variantId,
            actualQuantity: 4,
            allocations: [
              { salesLineId: saleLineId, allocatedQuantity: 4 },
              { purchaseLineId: purchaseLineId, allocatedQuantity: 4 },
            ],
          },
        ],
      },
      actor,
      {},
    );
    loadingIds.push(l1.id);
    await loading.confirm(INTEGRATION_COMPANY_ID, l1.id, actor, {});

    const saleAfterPartial = await prisma.salesDocument.findUniqueOrThrow({ where: { id: saleId } });
    const purchaseAfterPartial = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(saleAfterPartial.operationalLoadedAmount)).toBe(402); // 4 × 100.5 exact Decimal
    expect(Number(purchaseAfterPartial.operationalLoadedAmount)).toBe(200); // 4 × 50
    expect(saleAfterPartial.status).toBe('PARTIALLY_LOADED');
    expect(purchaseAfterPartial.status).toBe('PARTIALLY_LOADED');

    // Loading #2 allocates the remaining 6 to each side → fully loaded.
    const l2 = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          {
            productVariantId: variant.variantId,
            actualQuantity: 6,
            allocations: [
              { salesLineId: saleLineId, allocatedQuantity: 6 },
              { purchaseLineId: purchaseLineId, allocatedQuantity: 6 },
            ],
          },
        ],
      },
      actor,
      {},
    );
    loadingIds.push(l2.id);
    await loading.confirm(INTEGRATION_COMPANY_ID, l2.id, actor, {});

    const saleAfterFull = await prisma.salesDocument.findUniqueOrThrow({ where: { id: saleId } });
    const purchaseAfterFull = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(Number(saleAfterFull.operationalLoadedAmount)).toBe(1005); // 10 × 100.5
    expect(Number(purchaseAfterFull.operationalLoadedAmount)).toBe(500); // 10 × 50
    expect(saleAfterFull.status).toBe('COMPLETED');
    expect(purchaseAfterFull.status).toBe('COMPLETED');

    // Document flow: loading ↔ sales_document RELATED relations exist both ways.
    const relations = relationService(prisma);
    const fromSale = await relations.listRelations(INTEGRATION_COMPANY_ID, 'sales_document', saleId);
    const saleLoadingGroup = fromSale.relations.find((g: { type: string }) => g.type === 'loading')!;
    expect(saleLoadingGroup.count).toBe(2);
    // From the sale's view the loadings carry the numberless `بارگیری {date}` label.
    expect(saleLoadingGroup.items[0].label).toMatch(/^بارگیری \d{4}-\d{2}-\d{2}$/);

    const fromLoading = await relations.listRelations(INTEGRATION_COMPANY_ID, 'loading', l1.id);
    const salesGroup = fromLoading.relations.find((g: { type: string }) => g.type === 'sales_document')!;
    expect(salesGroup.items[0].id).toBe(saleId);
    // The loading side labels the other endpoint with the document number.
    expect(salesGroup.items[0].label).toBe(sale.documentNumber);
  });

  afterAll(async () => {
    for (const id of loadingIds) await cleanupLoading(prisma, id);
    await cleanupSalesDocument(prisma, saleId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await disconnectIntegrationPrisma();
  });
});
