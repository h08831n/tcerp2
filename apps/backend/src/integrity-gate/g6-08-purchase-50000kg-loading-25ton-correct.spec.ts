import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, purchaseService, createParty, cleanupPurchaseDocument } from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';
import { createVariantEx, seededUoms } from './g6-helpers';

/**
 * g6-08 — purchase-50000kg-loading-25ton-correct: the mirror of g6-07 on the
 * purchase side — a PO line of 50000 kg receives a loading allocation of 25
 * (expressed in the loading line's TON uom); the guard converts 25 t into
 * 25000 kg, under the ordered quantity, and the operational amount uses the
 * PO line's per-kg price.
 */
describeIntegration('g6-08 purchase-50000kg-loading-25ton-correct', () => {
  const prisma = integrationPrisma();
  const marker = `g6-08-${Date.now()}`;
  let actorId = '';
  let supplierId = '';
  let variantId = '';
  let purchaseId = '';
  let loadingId = '';

  it('25 t allocation against a 50000 kg PO → 25000 kg loaded, amount exact', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    supplierId = supplier.id;
    // kg-based PO line (price per kg).
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.kgId, inventoryUomId: uoms.kgId });
    variantId = variant.variantId;

    const purchase = purchaseService(prisma);
    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplierId, lines: [{ productVariantId: variantId, quantity: 50000, uomId: uoms.kgId, unitPrice: 10 }] },
      actor,
      {},
    );
    purchaseId = po.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    // The loading line is in TON — 25 t allocated.
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 25,
            uomId: uoms.tonId,
            allocations: [{ purchaseLineId: po.lines[0].id, allocatedQuantity: 25 }],
          },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const after = await prisma.purchaseDocument.findUniqueOrThrow({ where: { id: purchaseId } });
    // 25 t → 25000 kg loaded; amount = 25000 × 10 (price is per KG).
    expect(Number(after.operationalLoadedAmount)).toBe(250000);
    expect(after.status).toBe('PARTIALLY_LOADED');

    // 24 t more = 24000 kg → cumulative 49000 kg still under 50000: accepted
    // (and cleaned up immediately — it is only a DRAFT reservation).
    const ok = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 24,
            uomId: uoms.tonId,
            allocations: [{ purchaseLineId: po.lines[0].id, allocatedQuantity: 24 }],
          },
        ],
      },
      actor,
      {},
    );
    await cleanupLoading(prisma, ok.id);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
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
