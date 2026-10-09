import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, createVariant } from '../testing/p4-fixtures';
import {
  loadingService,
  approvalRequestService,
  setPartyBalance,
  cleanupLoading,
} from '../testing/p6-fixtures';

/**
 * p6-09 release-approval-flow: APPROVED releases the restricted driver info
 * (driverInfoRestricted=false) and REJECTED keeps it restricted; both write
 * the APPROVAL_* audit rows and notify the requester; an already-decided
 * request cannot be decided again (409 APPROVAL_ALREADY_DECIDED).
 */
describeIntegration('p6-09 release-approval-flow', () => {
  const prisma = integrationPrisma();
  const marker = `p6-09-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let driver = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let approvedLoadingId = '';
  let rejectedLoadingId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    driver = await createParty(prisma, ['DRIVER'], `${marker}-drv`);
    variant = await createVariant(prisma, marker);
  });

  it('APPROVED releases, REJECTED keeps restricted, notifications written', async () => {
    const loading = loadingService(prisma);
    const approvals = approvalRequestService(prisma);
    const actor = { id: actorId, username: 'admin' };
    await setPartyBalance(prisma, INTEGRATION_COMPANY_ID, customer.id, 250);

    const createRestricted = async () =>
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          customerPartyId: customer.id,
          driverPartyId: driver.id,
          lines: [{ productVariantId: variant.variantId, actualQuantity: 3 }],
        },
        actor,
        {},
      );

    // APPROVED path.
    const l1 = await createRestricted();
    approvedLoadingId = l1.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, approvedLoadingId, actor, {});
    const release = await loading.releaseDriverInfo(
      INTEGRATION_COMPANY_ID,
      approvedLoadingId,
      { decision: 'APPROVED', note: 'تسویه شد' },
      actor,
      {},
    );
    expect(release.status).toBe('APPROVED');
    expect(release.decidedBy).toBe(actorId);
    expect(release.decidedAt).toBeTruthy();
    expect(release.decisionNote).toBe('تسویه شد');

    const afterRelease = await prisma.loading.findUniqueOrThrow({ where: { id: approvedLoadingId } });
    expect(afterRelease.driverInfoRestricted).toBe(false);

    // REJECTED path — restriction stays.
    const l2 = await createRestricted();
    rejectedLoadingId = l2.id;
    await loading.confirm(INTEGRATION_COMPANY_ID, rejectedLoadingId, actor, {});
    const rejection = await loading.releaseDriverInfo(
      INTEGRATION_COMPANY_ID,
      rejectedLoadingId,
      { decision: 'REJECTED', note: 'بدهی باقی است' },
      actor,
      {},
    );
    expect(rejection.status).toBe('REJECTED');
    const afterRejection = await prisma.loading.findUniqueOrThrow({ where: { id: rejectedLoadingId } });
    expect(afterRejection.driverInfoRestricted).toBe(true); // stays restricted

    // No re-deciding.
    await expect(
      approvals.decide(INTEGRATION_COMPANY_ID, release.id, { decision: 'REJECTED' }, actor, {}),
    ).rejects.toMatchObject({ statusCode: 409, message: 'APPROVAL_ALREADY_DECIDED' });

    // Audit rows (APPROVAL_APPROVED / APPROVAL_REJECTED).
    const approvedAudits = await prisma.auditLog.findMany({
      where: { entityType: 'approval_request', entityId: release.id, action: 'APPROVAL_APPROVED' },
    });
    expect(approvedAudits).toHaveLength(1);
    const rejectedAudits = await prisma.auditLog.findMany({
      where: { entityType: 'approval_request', entityId: rejection.id, action: 'APPROVAL_REJECTED' },
    });
    expect(rejectedAudits).toHaveLength(1);

    // Notifications to the requester (requestedBy = the confirming actor).
    const notifications = await prisma.notification.findMany({
      where: { userId: actorId, relatedEntityType: 'loading', relatedEntityId: { in: [approvedLoadingId, rejectedLoadingId] } },
    });
    expect(notifications.length).toBe(2);
  });

  afterAll(async () => {
    await cleanupLoading(prisma, approvedLoadingId);
    await cleanupLoading(prisma, rejectedLoadingId);
    await disconnectIntegrationPrisma();
  });
});
