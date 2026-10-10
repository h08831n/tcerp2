import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { goodsReceiptService } from '../testing/p6-fixtures';
import { TemplatesService } from '../products/templates.service';
import { AuditService } from '../audit/audit.service';
import { createVariantEx, seededUoms, ensureMainWarehouse } from './g6-helpers';

/**
 * g6-04 — inventory-uom-locked-after-movements: once ANY stock_movement
 * exists for a variant, a PATCH that would CHANGE its inventory UOM is a 403
 * INVENTORY_UOM_LOCKED (aggregated history is expressed in that unit and can
 * never be silently re-based). A PATCH keeping the current value is allowed.
 */
describeIntegration('g6-04 inventory-uom-locked-after-movements', () => {
  const prisma = integrationPrisma();
  const marker = `g6-04-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let templateId = '';
  let purchaseId = '';
  let receiptId = '';
  let categoryId = '';

  it('with movements: change → 403 INVENTORY_UOM_LOCKED; same value → ok', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    supplierId = supplier.id;
    const main = await ensureMainWarehouse(prisma);

    // Variant with an explicit inventory uom (kg).
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;
    templateId = variant.templateId;
    const category = await prisma.productCategory.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` },
    });
    categoryId = category.id;

    // One movement (a confirmed goods receipt).
    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 5, uomId: uoms.kgId, unitPrice: 0 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    const draft = await goodsReceiptService(prisma).create(
      INTEGRATION_COMPANY_ID,
      {
        purchaseDocumentId: purchaseId,
        warehouseId: main.id,
        lines: [{ purchaseLineId: po.lines[0].id, actualQuantity: 5, uomId: uoms.kgId }],
      },
      actor,
      {},
    );
    receiptId = draft.id;
    await goodsReceiptService(prisma).confirm(INTEGRATION_COMPANY_ID, receiptId, actor, {});
    expect(
      await prisma.stockMovement.count({ where: { productVariantId: variantId, companyId: INTEGRATION_COMPANY_ID } }),
    ).toBe(1);

    const templates = new TemplatesService(prisma as never, new AuditService(prisma as never));
    const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });

    // Changing the inventory uom (ton) is LOCKED.
    await expect(
      templates.updateVariant(
        INTEGRATION_COMPANY_ID,
        templateId,
        variantId,
        { inventoryUomId: uoms.tonId, version: row.version } as never,
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: 'INVENTORY_UOM_LOCKED' });

    // Clearing it (null) is a change too — locked.
    await expect(
      templates.updateVariant(
        INTEGRATION_COMPANY_ID,
        templateId,
        variantId,
        { inventoryUomId: null, version: row.version } as never,
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: 'INVENTORY_UOM_LOCKED' });

    // Keeping the SAME value is a no-op PATCH — allowed.
    const same = await templates.updateVariant(
      INTEGRATION_COMPANY_ID,
      templateId,
      variantId,
      { inventoryUomId: uoms.kgId, version: row.version } as never,
      actor,
      {},
    );
    expect(same.inventoryUomId).toBe(uoms.kgId);
  });

  afterAll(async () => {
    await prisma.stockMovement.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { id: receiptId } } });
    await prisma.goodsReceipt.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: receiptId } }).catch(() => undefined);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: templateId } });
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: categoryId } }).catch(() => undefined);
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
