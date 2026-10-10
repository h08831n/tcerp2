import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId } from '../testing/p4-fixtures';
import { createCompany } from '../testing/p5-fixtures';
import { inventoryService, goodsReceiptService } from '../testing/p6-fixtures';
import { createVariantEx } from './g6-helpers';

/**
 * g6-24 — company-location-isolation: stock locations are company-scoped —
 * ensureLocations is idempotent per company, A's locations are invisible to
 * B (list + resolution), a per-party location is keyed per (company, party),
 * and a cross-company destination for a goods receipt is rejected
 * (DESTINATION_LOCATION_INVALID).
 */
describeIntegration('g6-24 company-location-isolation', () => {
  const prisma = integrationPrisma();
  const marker = `g6-24-${Date.now()}`;
  let actorId = '';
  let companyBId = '';

  it('locations never cross the company boundary', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const companyB = await createCompany(prisma, marker);
    companyBId = companyB.id;

    const inventory = inventoryService(prisma);
    await inventory.ensureLocations(INTEGRATION_COMPANY_ID);
    await inventory.ensureLocations(INTEGRATION_COMPANY_ID); // idempotent
    // B needs a warehouse so it owns an INTERNAL location of its own.
    await inventory.ensureDefaultWarehouse(prisma as never, companyBId);
    await inventory.ensureLocations(companyBId);

    const aLocations = (await inventory.listLocations(INTEGRATION_COMPANY_ID, {})) as { id: string; code: string }[];
    const bLocations = (await inventory.listLocations(companyBId, {})) as { id: string; code: string }[];
    expect(aLocations.length).toBeGreaterThan(0);
    expect(bLocations.length).toBeGreaterThan(0);
    // Zero id overlap: same codes, DIFFERENT rows per company.
    const aIds = new Set(aLocations.map((l) => l.id));
    for (const location of bLocations) expect(aIds.has(location.id)).toBe(false);
    const aCodes = new Set(aLocations.map((l) => l.code));
    for (const location of bLocations) expect(aCodes.has(location.code)).toBe(true);

    // Per-party locations are (company, party)-scoped.
    const partyA = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        type: 'COMPANY',
        nameFa: `طرف ${marker}-A`,
        roles: { create: [{ role: 'SUPPLIER' }] },
      },
    });
    const partyB = await prisma.party.create({
      data: {
        companyId: companyBId,
        type: 'COMPANY',
        nameFa: `طرف ${marker}-B`,
        roles: { create: [{ role: 'SUPPLIER' }] },
      },
    });
    const locA = await inventory.resolveLocation(prisma as never, INTEGRATION_COMPANY_ID, {
      type: 'SUPPLIER',
      partyId: partyA.id,
    });
    const locB = await inventory.resolveLocation(prisma as never, companyBId, {
      type: 'SUPPLIER',
      partyId: partyB.id,
    });
    expect(locA.companyId).toBe(INTEGRATION_COMPANY_ID);
    expect(locB.companyId).toBe(companyBId);
    expect(locA.id).not.toBe(locB.id);

    // B cannot resolve A's party (404) — out of scope.
    await expect(
      inventory.resolveLocation(prisma as never, companyBId, { type: 'SUPPLIER', partyId: partyA.id }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // B's receipt cannot target A's INTERNAL location (422).
    const category = await prisma.uomCategory.create({
      data: { companyId: companyBId, code: `W-${marker}`, nameFa: 'وزن' },
    });
    const bKg = await prisma.uom.create({
      data: {
        companyId: companyBId,
        categoryId: category.id,
        symbol: 'kgB24',
        nameFa: 'کیلوگرم',
        conversionRatio: '1',
        isBaseUnit: true,
      },
    });
    const variant = await createVariantEx(prisma, `${marker}-b`, {
      companyId: companyBId,
      defaultUomId: bKg.id,
      inventoryUomId: bKg.id,
    });
    const purchase = await prisma.purchaseDocument.create({
      data: {
        companyId: companyBId,
        documentNumber: `G6PO-${marker}`,
        supplierPartyId: partyB.id,
        buyerUserId: actorId,
        documentDate: new Date(),
        status: 'ORDER_PLACED',
        lines: {
          create: {
            companyId: companyBId,
            productVariantId: variant.variantId,
            orderedQuantity: 10,
            uomId: bKg.id,
            unitPrice: 1,
            lineTotal: 10,
          },
        },
      },
      include: { lines: true },
    });
    const aInternal = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, type: 'INTERNAL' },
    });
    // Sequences are seeded per company — give B its GRN counter (a fresh
    // runtime-created company has none until provisioned).
    await prisma.sequence.create({
      data: { companyId: companyBId, documentType: 'GOODS_RECEIPT', name: 'Goods receipt', prefix: 'GRN' },
    }).catch(() => undefined);
    const receipts = goodsReceiptService(prisma);
    await expect(
      receipts.create(
        companyBId,
        {
          purchaseDocumentId: purchase.id,
          destinationLocationId: aInternal.id,
          lines: [{ purchaseLineId: purchase.lines[0].id, actualQuantity: 10, uomId: bKg.id }],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'DESTINATION_LOCATION_INVALID' });

    // B's OWN INTERNAL location works.
    const bInternal = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: companyBId, type: 'INTERNAL' },
    });
    const draft = await receipts.create(
      companyBId,
      {
        purchaseDocumentId: purchase.id,
        destinationLocationId: bInternal.id,
        lines: [{ purchaseLineId: purchase.lines[0].id, actualQuantity: 10, uomId: bKg.id }],
      },
      actor,
      {},
    );
    expect(draft.destinationLocationId).toBe(bInternal.id);
  });

  afterAll(async () => {
    // Company B wholesale.
    await prisma.stockMovement.deleteMany({ where: { companyId: companyBId } });
    await prisma.goodsReceiptLine.deleteMany({ where: { receipt: { companyId: companyBId } } });
    await prisma.goodsReceipt.deleteMany({ where: { companyId: companyBId } });
    await prisma.documentRelation.deleteMany({ where: { companyId: companyBId } });
    await prisma.stockLocation.deleteMany({ where: { companyId: companyBId } });
    await prisma.purchaseDocument.deleteMany({ where: { companyId: companyBId } });
    await prisma.warehouse.deleteMany({ where: { companyId: companyBId } });
    await prisma.productVariant.deleteMany({ where: { companyId: companyBId } });
    await prisma.productTemplate.deleteMany({ where: { companyId: companyBId } });
    await prisma.productCategory.deleteMany({ where: { companyId: companyBId } });
    await prisma.uom.deleteMany({ where: { companyId: companyBId } });
    await prisma.uomCategory.deleteMany({ where: { companyId: companyBId } });
    await prisma.sequence.deleteMany({ where: { companyId: companyBId } });
    await prisma.party.deleteMany({ where: { companyId: companyBId } });
    await prisma.company.deleteMany({ where: { id: companyBId } }).catch(() => undefined);
    // Company A: this test's party + its location.
    const partyA = await prisma.party.findFirst({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `طرف ${marker}-A` },
      select: { id: true },
    });
    if (partyA) {
      await prisma.stockLocation.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, partyId: partyA.id } });
      await prisma.party.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, id: partyA.id } });
    }
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: { startsWith: `G6-${marker}` } } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `گیت۶ تست ${marker}` } } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: `G6-${marker}` } } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
