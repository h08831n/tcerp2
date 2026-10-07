import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  priceRequestService,
  createParty,
  createVariant,
} from '../testing/p4-fixtures';

/**
 * p4-19 yesterday-request-remains-same-record (REQUIREMENTS §14 Previous Day
 * Requests): an unanswered request from yesterday is NOT deleted, NOT copied
 * and NOT duplicated — the worklist returns the SAME record under
 * `previousDays`.
 */
describeIntegration('p4-19 previous-day requests keep the same record', () => {
  const prisma = integrationPrisma();
  const marker = `p4j${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let requestId = '';

  // Local noon of yesterday — TZ-safe "yesterday" for both the request and
  // the worklist query (padded local date parts).
  const yesterdayNoon = new Date();
  yesterdayNoon.setDate(yesterdayNoon.getDate() - 1);
  yesterdayNoon.setHours(12, 0, 0, 0);
  const yesterdayKey = `${yesterdayNoon.getFullYear()}-${String(yesterdayNoon.getMonth() + 1).padStart(2, '0')}-${String(yesterdayNoon.getDate()).padStart(2, '0')}`;

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
    const service = priceRequestService(prisma);
    const request = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        customerPartyId: customer.id,
        requestDate: yesterdayNoon.toISOString(),
        lines: [{ productVariantId: variant.variantId, requestedQuantity: 5 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    requestId = request.id;
  });

  it('today’s worklist lists it under previousDays — same id, exactly once', async () => {
    const service = priceRequestService(prisma);
    const worklist = await service.worklist(INTEGRATION_COMPANY_ID);

    // The shared dev DB can carry same-day manual rows — the guarantee under
    // test is that OUR yesterday request is NOT re-rendered as today's and
    // appears under previousDays exactly once (same record, no duplicate).
    expect(worklist.today.some((r: { id: string }) => r.id === requestId)).toBe(false);
    const inPrevious = worklist.previousDays.filter((r: { id: string }) => r.id === requestId);
    expect(inPrevious).toHaveLength(1); // same record, no duplicate
    const requestNumber = inPrevious[0].requestNumber as string;
    expect(worklist.previousDays.some((r: { id: string; requestNumber: string }) => r.requestNumber === requestNumber && r.id !== requestId)).toBe(false);
  });

  it('queried FOR yesterday it appears as today — the record itself is unchanged', async () => {
    const service = priceRequestService(prisma);
    const worklist = await service.worklist(INTEGRATION_COMPANY_ID, yesterdayKey);
    expect(worklist.today.map((r: { id: string }) => r.id)).toContain(requestId);

    // The status is still OPEN (nothing was mutated by worklist rendering).
    const row = await prisma.priceRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('OPEN');
  });

  afterAll(async () => {
    await prisma.priceRequest.deleteMany({ where: { id: requestId } });
    await prisma.party.deleteMany({ where: { id: customer.id } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
