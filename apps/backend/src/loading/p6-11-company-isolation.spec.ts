import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariantInCompany, createCompany } from '../testing/p5-fixtures';
import { purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import {
  loadingService,
  inventoryService,
  goodsReceiptService,
  mainWarehouse,
  cleanupLoading,
  cleanupGoodsReceipt,
  cleanupCompanyPhase6,
  stockQuery,
  movementQuery,
  loadingQuery,
} from '../testing/p6-fixtures';

/**
 * p6-11 company-isolation: loadings, stock, movements and warehouses of
 * company A are INVISIBLE to company B — cross-company reads are 404-style
 * and B's computed stock only counts B's movements. Also proves the lazy
 * default-warehouse creation (B gets its own MAIN on first use).
 */
describeIntegration('p6-11 company-isolation', () => {
  const prisma = integrationPrisma();
  const marker = `p6-11-${Date.now()}`;
  let actorId = '';
  let companyBId = '';
  let variantA = { variantId: '', templateId: '', categoryId: '', uomId: '', sku: '' };
  let loadingAId = '';
  let purchaseAId = '';
  let receiptAId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const companyB = await createCompany(prisma, marker);
    companyBId = companyB.id;

    // Company A: a goods receipt (IN) + a confirmed warehouse loading (OUT).
    const variant = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantA = variant;
    const actor = { id: actorId, username: 'admin' };

    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 30, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseAId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseAId, actor, {});
    const main = await mainWarehouse(prisma);
    const grn = await goodsReceiptService(prisma).create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseAId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 30, uomId: variantA.uomId }],
      },
      actor,
      {},
    );
    receiptAId = grn.id;
    await goodsReceiptService(prisma).confirm(INTEGRATION_COMPANY_ID, receiptAId, actor, {});

    const loading = loadingService(prisma);
    const l = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: main.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 10 }],
      },
      actor,
      {},
    );
    loadingAId = l.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingAId, actor, {});
  });

  it('A loadings/stock invisible to B; B resolves its own default warehouse', async () => {
    const loading = loadingService(prisma);
    const inventory = inventoryService(prisma);
    const actor = { id: actorId, username: 'admin' };

    // Direct read of A's loading from B → 404 semantics.
    await expect(
      loading.getById(companyBId, loadingAId, { canViewDriverInfo: true }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // B's lists/stock/movements see nothing of A.
    const bStock = await inventory.stock(companyBId, stockQuery());
    expect(bStock.total).toBe(0);
    const bMovements = await inventory.movements(companyBId, movementQuery());
    expect(bMovements.items).toHaveLength(0);
    const bList = await loading.list(companyBId, { userId: actorId, scopeAll: true }, loadingQuery());
    expect(bList.total).toBe(0);

    // A's own numbers are correct: IN 30 − OUT 10 = 20.
    const aStock = await inventory.stock(INTEGRATION_COMPANY_ID, stockQuery({ variantId: variantA.variantId }));
    expect(Number((aStock.items[0] as { stock: unknown }).stock)).toBe(20);

    // B CAN run its own operational flow — its own MAIN warehouse is created lazily.
    const variantB = await createVariantInCompany(prisma, companyBId, `${marker}-b`);
    const customerB = await createParty(prisma, ['CUSTOMER'], `${marker}-b`, companyBId);
    const bMain = await inventoryService(prisma).ensureDefaultWarehouse(prisma as never, companyBId);
    const lB = await loading.create(
      companyBId,
      {
        loadingDate: new Date(),
        route: 'WAREHOUSE_TO_CUSTOMER',
        warehouseId: bMain.id,
        customerPartyId: customerB.id,
        lines: [{ productVariantId: variantB.variantId, actualQuantity: 5 }],
      },
      actor,
      {},
    );
    try {
      await loading.confirm(companyBId, lB.id, actor, {});
      const movements = await prisma.stockMovement.findMany({ where: { sourceEntityId: lB.id } });
      expect(movements).toHaveLength(1);
      const bWarehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: companyBId, code: 'MAIN' } });
      expect(movements[0].warehouseId).toBe(bWarehouse.id); // B's own MAIN, not A's
      const bStockAfter = await inventory.stock(companyBId, stockQuery());
      expect(bStockAfter.total).toBe(1);
      expect(Number((bStockAfter.items[0] as { stock: unknown }).stock)).toBe(-5); // only B's OUT counted
    } finally {
      await cleanupLoading(prisma, lB.id);
    }
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingAId);
    await cleanupGoodsReceipt(prisma, receiptAId);
    await cleanupPurchaseDocument(prisma, purchaseAId);
    const markerPartyIds = (
      await prisma.party.findMany({
        where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: marker } },
        select: { id: true },
      })
    ).map((p) => p.id);
    await prisma.stockLocation.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, partyId: { in: markerPartyIds } },
    });
    await prisma.partyOperationalBalance.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, partyId: { in: markerPartyIds } },
    });
    await prisma.party.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: { in: markerPartyIds } } });
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantA.variantId } });
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantA.variantId } });
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantA.templateId } });
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantA.categoryId } });
    await prisma.uom.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantA.uomId } });
    await prisma.uomCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `P5W-${marker}` } });
    await cleanupCompanyPhase6(prisma, companyBId);
    await disconnectIntegrationPrisma();
  });
});
