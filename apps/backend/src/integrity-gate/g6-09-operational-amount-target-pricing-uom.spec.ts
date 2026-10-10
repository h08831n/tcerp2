import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, salesService, createParty, cleanupSalesDocument } from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';
import { createVariantEx, seededUoms } from './g6-helpers';

/**
 * g6-09 — operational-amount-target-pricing-uom: the operational amount is
 * computed in the DOCUMENT line's uom (the "target pricing uom"): a sale
 * priced per TON that is loaded 5000 kg must show 5 t × 100 = 500 — never
 * 5000 × 100. The conversion happens before the price multiplication, with
 * exact Decimal math.
 */
describeIntegration('g6-09 operational-amount-target-pricing-uom', () => {
  const prisma = integrationPrisma();
  const marker = `g6-09-${Date.now()}`;
  let actorId = '';
  let customerId = '';
  let variantId = '';
  let saleId = '';
  let loadingId = '';

  it('5000 kg loaded against a 10 t @ 100/t sale → amount 500', async () => {
    actorId = await adminUserId(prisma);
    const actor = { id: actorId, username: 'admin' };
    const uoms = await seededUoms(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], marker);
    customerId = customer.id;
    const variant = await createVariantEx(prisma, marker, { defaultUomId: uoms.tonId, inventoryUomId: uoms.tonId });
    variantId = variant.variantId;

    const sales = salesService(prisma);
    const scope = { userId: actorId, scope: 'ALL' as const };
    const sale = await sales.create(
      INTEGRATION_COMPANY_ID,
      scope,
      { customerPartyId: customerId, lines: [{ productVariantId: variantId, quantity: 10, uomId: uoms.tonId, unitPrice: 100 }] },
      actor,
      {},
    );
    saleId = sale.id;
    await sales.confirm(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});
    await sales.activate(INTEGRATION_COMPANY_ID, scope, saleId, actor, {});

    const loading = loadingService(prisma);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customerId,
        lines: [
          {
            productVariantId: variantId,
            actualQuantity: 5000,
            uomId: uoms.kgId,
            allocations: [{ salesLineId: sale.lines[0].id, allocatedQuantity: 5000 }],
          },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});

    const after = await prisma.salesDocument.findUniqueOrThrow({ where: { id: saleId } });
    expect(Number(after.operationalLoadedAmount)).toBe(500); // 5 t × 100 — NOT 5000 × 100
    expect(after.status).toBe('PARTIALLY_LOADED');
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await cleanupSalesDocument(prisma, saleId);
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
