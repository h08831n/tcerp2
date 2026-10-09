import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, createVariant } from '../testing/p4-fixtures';
import { loadingService, setPartyBalance, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-08 debt-gate-restricts-driver-info (REQUIREMENTS §20): confirming a
 * loading for a customer whose PartyOperationalBalance > 0 creates a PENDING
 * `RELEASE_DRIVER_INFO` ApprovalRequest and sets driverInfoRestricted — the
 * debt does NOT block the loading, it only hides driver/carrier info.
 * Salespersons (no release/decide permission) get the stripped payload;
 * managers see everything.
 */
describeIntegration('p6-08 debt-gate-restricts-driver-info', () => {
  const prisma = integrationPrisma();
  const marker = `p6-08-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let driver = { id: '', nameFa: '' };
  let carrier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    driver = await createParty(prisma, ['DRIVER'], `${marker}-drv`);
    carrier = await createParty(prisma, ['CARRIER'], `${marker}-car`);
    variant = await createVariant(prisma, marker);
  });

  it('balance > 0 → approval created + restricted; salesperson sees stripped payload', async () => {
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    // The claims service maintains this row; here it is seeded directly.
    await setPartyBalance(prisma, INTEGRATION_COMPANY_ID, customer.id, 500);

    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customer.id,
        driverPartyId: driver.id,
        carrierPartyId: carrier.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 8 }],
      },
      actor,
      {},
    );
    loadingId = created.id;

    // The debt does NOT block confirmation.
    const confirmed = await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    expect(confirmed.status).toBe('CONFIRMED');

    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { entityType: 'loading', entityId: loadingId, approvalType: 'RELEASE_DRIVER_INFO' },
    });
    expect(approval.status).toBe('PENDING');
    expect(approval.companyId).toBe(INTEGRATION_COMPANY_ID);
    expect(approval.requestedBy).toBe(actorId);

    const row = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(row.driverInfoRestricted).toBe(true);

    // Salesperson view (no release/decide permission): driver/carrier stripped.
    const restricted = await loading.getById(INTEGRATION_COMPANY_ID, loadingId, { canViewDriverInfo: false });
    expect(restricted.driver).toBeNull();
    expect(restricted.carrier).toBeNull();
    expect(restricted.restricted).toBe(true);
    expect(restricted.driverPartyId).toBe(driver.id); // the raw FK stays (ids are not sensitive)

    // Manager view (holds loading.driver_info.release or approvals.decide).
    const manager = await loading.getById(INTEGRATION_COMPANY_ID, loadingId, { canViewDriverInfo: true });
    expect(manager.restricted).toBe(false);
    expect(manager.driver?.nameFa).toBe(driver.nameFa);
    expect(manager.carrier?.nameFa).toBe(carrier.nameFa);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await disconnectIntegrationPrisma();
  });
});
