import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, createVariant } from '../testing/p4-fixtures';
import { loadingService, inventoryService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-02 confirm-idempotent: a double confirm is a 403 LOADING_CONFIRMED, and
 * a FORCED re-run of the movement generation seam (same transaction shape as
 * confirm) creates no duplicate StockMovement rows — the unique idempotency
 * keys are the only authority, so a document re-confirmation can never
 * double-count stock.
 */
describeIntegration('p6-02 confirm-idempotent', () => {
  const prisma = integrationPrisma();
  const marker = `p6-02-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);
  });

  it('double confirm → LOADING_CONFIRMED; forced movement re-run → no duplicates', async () => {
    const service = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const created = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 25 }],
      },
      actor,
      {},
    );
    loadingId = created.id;

    await service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    await expect(
      service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {}),
    ).rejects.toMatchObject({ statusCode: 403, message: 'LOADING_CONFIRMED' });

    // Forced re-run of the generation seam (same shape as confirm: the route
    // endpoints of the DIRECT default route + the line's effective uom).
    await prisma.$transaction(async (tx) => {
      const loading = await tx.loading.findFirstOrThrow({
        where: { id: loadingId },
        include: { lines: true },
      });
      const customerLocation = await tx.stockLocation.findFirstOrThrow({
        where: { companyId: INTEGRATION_COMPANY_ID, code: `CUSTOMER-${customer.id}` },
      });
      const supplierLocation = await tx.stockLocation.findFirstOrThrow({
        where: { companyId: INTEGRATION_COMPANY_ID, code: 'SUPPLIER-DEFAULT' },
      });
      const endpoints = new Map(
        loading.lines.map((line) => [
          line,
          {
            sourceLocationId: supplierLocation.id,
            destinationLocationId: customerLocation.id,
            warehouseId: null,
          },
        ]),
      );
      const effectiveUoms = new Map(loading.lines.map((line) => [line, variant.uomId]));
      await service.generateMovements(
        tx,
        { id: loading.id, companyId: loading.companyId, loadingDate: loading.loadingDate, route: loading.route },
        loading.lines,
        endpoints,
        effectiveUoms,
        actorId,
      );
    });

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
    });
    expect(movements).toHaveLength(1); // ON CONFLICT DO NOTHING — no duplicate row
    expect(movements[0].idempotencyKey).toBe(`loading:${loadingId}:line:${created.lines[0].id}`);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
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
