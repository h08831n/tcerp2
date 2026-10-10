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
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';
import { createVariantEx, seededUoms } from './g6-helpers';

/**
 * g6-18 — reversal-restores-operational-status: reversing the loading rolls
 * the operational loaded amount back on BOTH documents and recomputes their
 * statuses — PARTIALLY_LOADED falls back to the base active status
 * (SALES_ORDER / ORDER_PLACED) when the reversal strips the only loading.
 */
describeIntegration('g6-18 reversal-restores-operational-status', () => {
  const prisma = integrationPrisma();
  const marker = `g6-18-${Date.now()}`;
  let actorId = '';
  let customerId = '';
  let supplierId = '';
  let variantId = '';
  let saleId = '';
  let purchaseId = '';
  let loadingId = '';

  it('PARTIALLY_LOADED → base status; operational amounts back to zero', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    const supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-sup`);
    customerId = customer.id;
    supplierId = supplier.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;

    const sales = salesService(prisma);
    const scope = { userId: actorId, scope: 'ALL' as const };
    const sale = await sales.create(
      INTEGRATION_COMPANY_ID,
      scope,
      { customerPartyId: customerId, lines: [{ productVariantId: variantId, quantity: 10, uomId: uoms.kgId, unitPrice: 100.5 }] },
      actor,
      {},
    );
    saleId = sale.id;
    await sales.confirm(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});
    await sales.activate(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 10, uomId: uoms.kgId, unitPrice: 50 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customerId,
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 4,
            allocations: [
              { salesLineId: sale.lines[0].id, allocatedQuantity: 4 },
              { purchaseLineId: po.lines[0].id, allocatedQuantity: 4 },
            ],
          },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    let saleRow = await prisma.salesDocument.findUniqueOrThrow({ where: { id: saleId } });
    let poRow = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    expect(saleRow.status).toBe('PARTIALLY_LOADED');
    expect(Number(saleRow.operationalLoadedAmount)).toBe(402); // 4 × 100.5
    expect(poRow.status).toBe('PARTIALLY_LOADED');
    expect(Number(poRow.operationalLoadedAmount)).toBe(200); // 4 × 50

    await loading.reverse(INTEGRATION_COMPANY_ID, loadingId, { reason: 'خطای ثبت' }, actor, {});

    saleRow = await prisma.salesDocument.findUniqueOrThrow({ where: { id: saleId } });
    poRow = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    // Both documents fall back to their base active status with a zeroed
    // operational amount (rollback by construction — full recompute).
    expect(saleRow.status).toBe('SALES_ORDER');
    expect(Number(saleRow.operationalLoadedAmount)).toBe(0);
    expect(poRow.status).toBe('ORDER_PLACED');
    expect(Number(poRow.operationalLoadedAmount)).toBe(0);

    // The reversal released the reservations — a new allocation fits again.
    const retry = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customerId,
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 10,
            allocations: [
              { salesLineId: sale.lines[0].id, allocatedQuantity: 10 },
              { purchaseLineId: po.lines[0].id, allocatedQuantity: 10 },
            ],
          },
        ],
      },
      actor,
      {},
    );
    await cleanupLoading(prisma, retry.id);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await cleanupSalesDocument(prisma, saleId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` } }).catch(() => undefined);
    const partyIds = (
      await prisma.party.findMany({
        where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: marker } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await prisma.stockLocation.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, partyId: { in: partyIds } } });
    await prisma.party.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: { in: partyIds } } });
    await disconnectIntegrationPrisma();
  });
});
