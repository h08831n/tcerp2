import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, salesService, createParty, cleanupSalesDocument } from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';
import { seededUoms, createVariantEx } from './g6-helpers';

/**
 * g6-07 — sales-50ton-loading-25000kg-loaded-25ton: the allocation quantity
 * is expressed in the LOADING LINE's uom (kg here) and converted into the
 * sales line's uom (ton) before every comparison and amount computation —
 * 25000 kg against a 50 ton order loads exactly 25 ton.
 */
describeIntegration('g6-07 sales-50ton-loading-25000kg-loaded-25ton', () => {
  const prisma = integrationPrisma();
  const marker = `g6-07-${Date.now()}`;
  let actorId = '';
  let customerId = '';
  let variantId = '';
  let saleId = '';
  let loadingId = '';

  it('25000 kg against a 50 t sale → 25 t loaded, amount in the sale line uom', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], marker);
    customerId = customer.id;
    // ton-based sale line.
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.tonId, inventoryUomId: uoms.tonId });
    variantId = variant.variantId;

    const sales = salesService(prisma);
    const scope = { userId: actorId, scope: 'ALL' as const };
    const sale = await sales.create(
      INTEGRATION_COMPANY_ID,
      scope,
      { customerPartyId: customerId, lines: [{ productVariantId: variantId, quantity: 50, uomId: uoms.tonId, unitPrice: 100 }] },
      actor,
      {},
    );
    saleId = sale.id;
    await sales.confirm(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});
    await sales.activate(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});

    // The loading LINE is in kg; the allocation inherits the line's uom.
    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customerId,
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 25000,
            uomId: uoms.kgId,
            allocations: [{ salesLineId: sale.lines[0].id, allocatedQuantity: 25000 }],
          },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const after = await prisma.salesDocument.findUniqueOrThrow({ where: { id: saleId } });
    // 25000 kg → 25 ton loaded; amount = 25 × 100 (price is per TON).
    expect(Number(after.operationalLoadedAmount)).toBe(2500);
    expect(after.status).toBe('PARTIALLY_LOADED');
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await cleanupSalesDocument(prisma, saleId);
    await prisma.productVariant.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, sku: `G6-${marker}` } }).catch(() => undefined);
    await prisma.productTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, nameFa: `گیت۶ تست ${marker}` } }).catch(() => undefined);
    await prisma.productCategory.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `G6-${marker}` },
    }).catch(() => undefined);
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
