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
} from '../testing/p6-fixtures';

/**
 * p6-14 warehouse-default-resolution: a goods receipt with NO warehouseId
 * lands its IN movements in the company DEFAULT warehouse (MAIN); an
 * explicit warehouseId (GRN or a WAREHOUSE-route loading) is honored.
 * Warehouse defaults follow the UOM base-unit precedent: promoting a second
 * default is a 409, set-default flips.
 */
describeIntegration('p6-14 warehouse-default-resolution', () => {
  const prisma = integrationPrisma();
  const marker = `p6-14-${Date.now()}`;
  let actorId = '';
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let purchaseId = '';
  let receiptId = '';
  let loadingId = '';
  let extraWarehouseId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplier = await createParty(prisma, ['SUPPLIER'], marker);
    variant = await createVariant(prisma, marker);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);
    await mainWarehouse(prisma);
  });

  it('no warehouseId → default used; explicit warehouse honored; default uniqueness enforced', async () => {
    const inventory = inventoryService(prisma);
    const loading = loadingService(prisma);
    const receipts = goodsReceiptService(prisma);
    const purchase = purchaseService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const main = await prisma.warehouse.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'MAIN' },
    });
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    // (a) No warehouseId → default MAIN (the INTERNAL LOC-MAIN location).
    const grn = await receipts.create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 3, uomId: variant.uomId }],
      },
      actor,
      {},
    );
    receiptId = grn.id;
    await receipts.confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});
    const grnMovements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'PURCHASE_RECEIPT', sourceEntityId: receiptId },
    });
    expect(grnMovements).toHaveLength(1);
    expect(grnMovements[0].warehouseId).toBe(main.id);

    // (b) Explicit warehouse honored (WAREHOUSE_TO_CUSTOMER loading).
    const extra = await inventory.createWarehouse(
      INTEGRATION_COMPANY_ID,
      { code: `P6W-${marker}`, nameFa: 'انبار تست ۶-۱۴' },
      actor,
      {},
    );
    extraWarehouseId = extra.id;
    const b = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: extraWarehouseId,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 2 }],
      },
      actor,
      {},
    );
    loadingId = b.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    const bMovements = await prisma.stockMovement.findMany({ where: { sourceEntityId: loadingId } });
    expect(bMovements).toHaveLength(1);
    expect(bMovements[0].warehouseId).toBe(extraWarehouseId);

    // (c) At-most-one default (UOM base precedent): MAIN is still default →
    // creating another default is a 409 WAREHOUSE_DEFAULT_EXISTS.
    await expect(
      inventory.createWarehouse(
        INTEGRATION_COMPANY_ID,
        { code: `P6W2-${marker}`, nameFa: 'انبار دوم', isDefault: true },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WAREHOUSE_DEFAULT_EXISTS' });

    // (d) set-default FLIPS: extra becomes the only default.
    await inventory.setDefaultWarehouse(INTEGRATION_COMPANY_ID, extraWarehouseId, actor, {});
    const defaults = await prisma.warehouse.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, isDefault: true },
    });
    expect(defaults).toHaveLength(1);
    expect(defaults[0].id).toBe(extraWarehouseId);

    // Restore MAIN as default for the shared integration company.
    await inventory.setDefaultWarehouse(INTEGRATION_COMPANY_ID, main.id, actor, {});

    // (e) A warehouse with movements cannot be deleted.
    await expect(
      inventory.deleteWarehouse(INTEGRATION_COMPANY_ID, extraWarehouseId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 409, message: 'WAREHOUSE_IN_USE' });
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await cleanupGoodsReceipt(prisma, receiptId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    if (extraWarehouseId) {
      await prisma.warehouse.deleteMany({ where: { id: extraWarehouseId } }).catch(() => undefined);
    }
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
