import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, createVariant } from '../testing/p4-fixtures';
import { loadingService, setPartyBalance, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-10 no-debt-no-restriction: a zero (or missing) operational balance
 * confirms the loading WITHOUT an approval request; driver info is visible to
 * everyone (no restriction flag, no stripping).
 */
describeIntegration('p6-10 no-debt-no-restriction', () => {
  const prisma = integrationPrisma();
  const marker = `p6-10-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let driver = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let loadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    driver = await createParty(prisma, ['DRIVER'], `${marker}-drv`);
    variant = await createVariant(prisma, marker);
  });

  it('zero balance → confirmed without approval, driver visible', async () => {
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    // Explicit ZERO balance row (no debt).
    await setPartyBalance(prisma, INTEGRATION_COMPANY_ID, customer.id, 0);

    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        customerPartyId: customer.id,
        driverPartyId: driver.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 2 }],
      },
      actor,
      {},
    );
    loadingId = created.id;

    const confirmed = await loading.confirm(INTEGRATION_COMPANY_ID, loadingId, actor, {});
    expect(confirmed.status).toBe('CONFIRMED');

    const approvals = await prisma.approvalRequest.count({
      where: { entityType: 'loading', entityId: loadingId },
    });
    expect(approvals).toBe(0);

    const row = await prisma.loading.findUniqueOrThrow({ where: { id: loadingId } });
    expect(row.driverInfoRestricted).toBe(false);

    // Even the restricted-scope viewer (salesperson) sees the driver.
    const view = await loading.getById(INTEGRATION_COMPANY_ID, loadingId, { canViewDriverInfo: false });
    expect(view.restricted).toBe(false);
    expect(view.driver?.nameFa).toBe(driver.nameFa);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, loadingId);
    await disconnectIntegrationPrisma();
  });
});
