import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  salesService,
  createParty,
  createVariant,
  createLostReason,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';
import { SALES_LOST_REASON_REQUIRED_SETTING } from './sales-documents.service';

/**
 * p4-29 lost-requires-reason (configurable): marking a quotation LOST
 * requires a lost reason while the company Setting
 * `sales.lost_reason_required` is true (default); when the company turns it
 * off, losing without a reason is accepted.
 */
describeIntegration('p4-29 lost requires a (configurable) reason', () => {
  const prisma = integrationPrisma();
  const marker = `p4o${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let lostReasonId = '';
  const docIds: string[] = [];

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
    lostReasonId = await createLostReason(prisma, marker);
  });

  async function createQuotation(): Promise<string> {
    const service = salesService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 1, unitPrice: 100 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    docIds.push(doc.id);
    return doc.id;
  }

  it('default rule: losing WITHOUT a reason → 422 LOST_REASON_REQUIRED', async () => {
    const docId = await createQuotation();
    const service = salesService(prisma);
    await expect(
      service.lost(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, docId, { lostReasonId: '' } as never, { id: actorId, username: 'admin' }, {}),
    ).rejects.toMatchObject({ statusCode: 422, message: 'LOST_REASON_REQUIRED' });
  });

  it('default rule: losing WITH a company lost reason → LOST + timeline event', async () => {
    const docId = await createQuotation();
    const service = salesService(prisma);
    const result = await service.lost(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      docId,
      { lostReasonId },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(result.status).toBe('LOST');
    expect(result.lostReason?.id).toBe(lostReasonId);

    const events = await prisma.timelineEvent.findMany({
      where: { entityType: 'PARTY', entityId: customer.id, type: 'SALE_LOST' },
    });
    expect(events.length).toBeGreaterThanOrEqual(1);
  });

  it('configurable: Setting sales.lost_reason_required=false allows a reason-less loss', async () => {
    await prisma.setting.upsert({
      where: { companyId_key: { companyId: INTEGRATION_COMPANY_ID, key: SALES_LOST_REASON_REQUIRED_SETTING } },
      create: { companyId: INTEGRATION_COMPANY_ID, key: SALES_LOST_REASON_REQUIRED_SETTING, value: false, category: 'sales' },
      update: { value: false },
    });
    try {
      const docId = await createQuotation();
      const service = salesService(prisma);
      const result = await service.lost(
        INTEGRATION_COMPANY_ID,
        { userId: actorId, scope: 'ALL' },
        docId,
        {} as never,
        { id: actorId, username: 'admin' },
        {},
      );
      expect(result.status).toBe('LOST');
      expect(result.lostReasonId).toBeNull();
    } finally {
      await prisma.setting.deleteMany({
        where: { companyId: INTEGRATION_COMPANY_ID, key: SALES_LOST_REASON_REQUIRED_SETTING },
      });
    }
  });

  afterAll(async () => {
    for (const id of docIds) await cleanupSalesDocument(prisma, id);
    await prisma.party.deleteMany({ where: { id: customer.id } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
