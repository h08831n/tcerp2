import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, createVariant } from '../testing/p4-fixtures';
import { inventoryService, loadingService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-01 loading-confirm-generates-out-movements: confirming a loading with 2
 * lines generates exactly 2 OUT StockMovement rows — one per line — with the
 * `loading:{loadingId}:line:{lineId}` idempotency keys, the line's verbatim
 * source quantity/uom pair plus the normalized pair, ALONG THE ROUTE
 * (Integrity Gate #10): the default DIRECT route runs SUPPLIER location →
 * CUSTOMER location (external endpoints — no internal impact).
 */
describeIntegration('p6-01 loading-confirm-generates-out-movements', () => {
  const prisma = integrationPrisma();
  const marker = `p6-01-${Date.now()}`;
  let actorId = '';
  let supplier = { id: '', nameFa: '' };
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-sup`);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    variant = await createVariant(prisma, marker);
    await inventoryService(prisma).ensureLocations(INTEGRATION_COMPANY_ID);
  });

  it('confirm generates one OUT movement per line along the route (SUPPLIER → CUSTOMER)', async () => {
    const service = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const created = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customer.id,
        lines: [
          { productVariantId: variant.variantId, actualQuantity: 100 },
          { productVariantId: variant.variantId, actualQuantity: 50 },
        ],
      },
      actor,
      {},
    );
    loadingId = created.id;

    const confirmed = await service.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    expect(confirmed.status).toBe('CONFIRMED');

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'LOADING', sourceEntityId: loadingId },
      orderBy: { sourceQuantity: 'desc' },
    });
    expect(movements).toHaveLength(2);

    const lineIds = created.lines.map((line: { id: string }) => line.id);
    // No purchase allocation → the DEFAULT supplier location.
    const supplierLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: 'SUPPLIER-DEFAULT' },
    });
    const customerLocation = await prisma.stockLocation.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, code: `CUSTOMER-${customer.id}` },
    });

    movements.forEach((movement) => {
      expect(movement.direction).toBe('OUT');
      expect(movement.companyId).toBe(INTEGRATION_COMPANY_ID);
      expect(movement.movementDate.toISOString()).toBe(created.loadingDate.toISOString());
      expect(lineIds).toContain(
        movement.idempotencyKey.replace(`loading:${loadingId}:line:`, ''),
      );
      // Route endpoints (Integrity Gate #10): supplier → customer, no warehouse.
      expect(movement.sourceLocationId).toBe(supplierLocation.id);
      expect(movement.destinationLocationId).toBe(customerLocation.id);
      expect(movement.warehouseId).toBeNull();
      // Both quantity pairs are stored (verbatim source + normalized).
      expect(movement.sourceUomId).toBe(variant.uomId);
      expect(movement.inventoryUomId).toBe(variant.uomId); // default fallback = kg
      expect(Number(movement.normalizedQuantity)).toBe(Number(movement.sourceQuantity));
    });
    const quantities = movements.map((m) => Number(m.sourceQuantity)).sort((a, b) => b - a);
    expect(quantities).toEqual([100, 50]);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    // Locations reference the party (FK) — delete them first.
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
