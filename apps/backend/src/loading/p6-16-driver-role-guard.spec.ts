import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createParty, createVariant } from '../testing/p4-fixtures';
import { loadingService, cleanupLoading } from '../testing/p6-fixtures';

/**
 * p6-16 driver-role-guard: a driver/carrier party WITHOUT the DRIVER/CARRIER
 * role is rejected with NOT_A_DRIVER / NOT_A_CARRIER; a customer without the
 * CUSTOMER role with NOT_A_CUSTOMER. Cross-company parties are treated as
 * missing (same 422).
 */
describeIntegration('p6-16 driver-role-guard', () => {
  const prisma = integrationPrisma();
  const marker = `p6-16-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let plainParty = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-cust`);
    plainParty = await createParty(prisma, [], `${marker}-plain`);
    variant = await createVariant(prisma, marker);
  });

  it('driver/carrier/customer must hold their role', async () => {
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };

    await expect(
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          driverPartyId: plainParty.id, // no DRIVER role
          lines: [{ productVariantId: variant.variantId, actualQuantity: 1 }],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'NOT_A_DRIVER' });

    await expect(
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          carrierPartyId: plainParty.id, // no CARRIER role
          lines: [{ productVariantId: variant.variantId, actualQuantity: 1 }],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'NOT_A_CARRIER' });

    await expect(
      loading.create(
        INTEGRATION_COMPANY_ID,
        {
          loadingDate: new Date(),
          customerPartyId: plainParty.id, // no CUSTOMER role
          lines: [{ productVariantId: variant.variantId, actualQuantity: 1 }],
        },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'NOT_A_CUSTOMER' });
  });

  it('a DRIVER-role party is accepted and lands on the draft', async () => {
    const loading = loadingService(prisma);
    const actor = { id: actorId, username: 'admin' };
    const driver = await createParty(prisma, ['DRIVER'], `${marker}-drv`);
    const created = await loading.create(
      INTEGRATION_COMPANY_ID,
      {
        loadingDate: new Date(),
        driverPartyId: driver.id,
        lines: [{ productVariantId: variant.variantId, actualQuantity: 1 }],
      },
      actor,
      {},
    );
    expect(created.driverPartyId).toBe(driver.id);
    await cleanupLoading(prisma, created.id);
  });

  afterAll(async () => {
    await prisma.party.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: marker } },
    });
    await disconnectIntegrationPrisma();
  });
});
