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
  cleanupLoading,
  cleanupPurchaseReceive,
  stockQuery,
} from '../testing/p6-fixtures';

interface StockRow {
  stock: { toString(): string };
  negative: boolean;
  variant: { sku: string; uomSymbol: string | null };
}

/**
 * p6-04 computed-stock: stock per variant = SUM(IN) − SUM(OUT) — IN 50 then
 * OUT 20 computes 30; driving it further negative (OUT 40 more) is ALLOWED
 * but flagged `negative: true` (warning semantics, nothing blocks).
 */
describeIntegration('p6-04 computed-stock', () => {
  const prisma = integrationPrisma();
  const marker = `p6-04-${Date.now()}`;
  let actorId = '';
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let purchaseId = '';
  const loadingIds: string[] = [];

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplier = await createParty(prisma, ['SUPPLIER'], marker);
    variant = await createVariant(prisma, marker);
  });

  it('IN 50 − OUT 20 → 30; more OUT than IN → negative flagged', async () => {
    const inventory = inventoryService(prisma);
    const loading = loadingService(prisma);
    const purchase = purchaseService(prisma);
    const actor = { id: actorId, username: 'admin' };

    // IN 50 (purchase receive).
    const created = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 50, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseId = created.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    await purchase.receive(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    // OUT 20 (confirmed loading).
    const l1 = await loading.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variant.variantId, actualQuantity: 20 }] },
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

    // OUT 40 more → computed stock −10, flagged negative, not blocked.
    const l2 = await loading.create(
      INTEGRATION_COMPANY_ID,
      { loadingDate: new Date(), lines: [{ productVariantId: variant.variantId, actualQuantity: 40 }] },
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
    await cleanupPurchaseReceive(prisma, purchaseId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await disconnectIntegrationPrisma();
  });
});
