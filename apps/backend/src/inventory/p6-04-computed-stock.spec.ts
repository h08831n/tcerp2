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
import {
  inventoryService,
  loadingService,
  goodsReceiptService,
  mainWarehouse,
  cleanupLoading,
  cleanupGoodsReceipt,
  stockQuery,
} from '../testing/p6-fixtures';

interface StockRow {
  stock: { toString(): string };
  negative: boolean;
  variant: { sku: string; uomSymbol: string | null };
}

/**
 * p6-04 computed-stock: company stock aggregates ONLY normalizedQuantity
 * with LOCATION semantics (Integrity Gate #7) — arrivals at an INTERNAL
 * location from outside add, departures subtract. A goods receipt of 50 then
 * a warehouse→customer loading of 20 computes 30; driving it further negative
 * (20 more OUT) is ALLOWED under the default WARN policy and flagged
 * `negative: true` — nothing blocks.
 */
describeIntegration('p6-04 computed-stock', () => {
  const prisma = integrationPrisma();
  const marker = `p6-04-${Date.now()}`;
  let actorId = '';
  let supplier = { id: '', nameFa: '' };
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let purchaseId = '';
  let receiptId = '';
  const loadingIds: string[] = [];

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-sup`);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    variant = await createVariant(prisma, marker);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);
    await mainWarehouse(prisma);
  });

  it('IN 50 − OUT 20 → 30; more OUT than IN → negative flagged', async () => {
    const inventory = inventoryService(prisma);
    const loading = loadingService(prisma);
    const receipts = goodsReceiptService(prisma);
    const purchase = purchaseService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const main = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'MAIN' },
    });

    // IN 50 (goods receipt into MAIN).
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 50, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    const grn = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 50, uomId: variant.uomId }],
      },
      actor,
      {},
    );
    receiptId = grn.id;
    await receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});

    // OUT 20 (confirmed WAREHOUSE_TO_CUSTOMER loading).
    const l1 = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 20 }],
      },
      actor,
      {},
    );
    loadingIds.push(l1.id);
    await loading.confirm(INTEGRATION_COMPANY_ID, l1.id, actor, {});

    const positive = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId: variant.variantId }));
    const positiveRow = positive.items[0] as StockRow;
    expect(positive.total).toBe(1);
    expect(Number(positiveRow.stock)).toBe(30);
    expect(positiveRow.negative).toBe(false);
    expect(positiveRow.variant.sku).toBe(variant.sku);
    expect(positiveRow.variant.uomSymbol).toBe('kg');

    // OUT 40 more → computed stock −10, flagged negative, not blocked (WARN).
    const l2 = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 40 }],
      },
      actor,
      {},
    );
    loadingIds.push(l2.id);
    await loading.confirm(INTEGRATION_COMPANY_ID, l2.id, actor, {});

    const negative = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId: variant.variantId }));
    const negativeRow = negative.items[0] as StockRow;
    expect(Number(negativeRow.stock)).toBe(-10);
    expect(negativeRow.negative).toBe(true);
  });

  afterAll(async () => {
    for (const id of loadingIds) await cleanupLoading(prisma, id);
    await cleanupGoodsReceipt(prisma, receiptId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    const parties = await prisma.party.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: marker } },
      select: { id: true },
    });
    await prisma.stockLocation.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, partyId: { in: parties.map((p) => p.id) } },
    });
    await prisma.party.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, id: { in: parties.map((p) => p.id) } },
    });
    await disconnectIntegrationPrisma();
  });
});
