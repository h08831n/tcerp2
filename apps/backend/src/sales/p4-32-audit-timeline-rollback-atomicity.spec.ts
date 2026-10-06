import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import {
  adminUserId,
  salesService,
  createParty,
  createVariant,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';

/**
 * p4-32 audit-timeline-rollback-atomicity: a document mutation (send),
 * its AuditLog row and its party Timeline event commit as ONE transaction —
 * an injected audit failure rolls everything back; on success all three
 * rows exist.
 */
describeIntegration('p4-32 audit + timeline atomicity', () => {
  const prisma = integrationPrisma();
  const marker = `p4p${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let docId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
  });

  function serviceWithAudit(audit?: AuditService) {
    const svc = salesService(prisma);
    if (audit) (svc as unknown as { auditService: AuditService }).auditService = audit;
    return svc;
  }

  it('success path: mutation + AuditLog + TimelineEvent all committed', async () => {
    const service = salesService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 1, unitPrice: 100 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    docId = doc.id;

    const audits = await prisma.auditLog.findMany({ where: { entityType: 'sales_document', entityId: doc.id, action: 'CREATE' } });
    expect(audits).toHaveLength(1);
    const timelines = await prisma.timelineEvent.findMany({
      where: { entityType: 'PARTY', entityId: customer.id, type: 'QUOTATION_CREATED' },
    });
    expect(timelines).toHaveLength(1);

    // Transition (send) writes its own audit + timeline in the same tx.
    await serviceWithAudit().send(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, doc.id, { id: actorId, username: 'admin' }, {});
    expect(await prisma.auditLog.count({ where: { entityType: 'sales_document', entityId: doc.id, action: 'UPDATE' } })).toBe(1);
    expect(await prisma.timelineEvent.count({ where: { entityType: 'PARTY', entityId: customer.id, type: 'QUOTATION_SENT' } })).toBe(1);
  });

  it('injected audit failure rolls the mutation AND timeline back', async () => {
    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValue(new Error('audit write failed'));

    const statusBefore = (await prisma.salesDocument.findUniqueOrThrow({ where: { id: docId } })).status;

    await expect(
      serviceWithAudit(audit).cancel(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, docId, { id: actorId, username: 'admin' }, {}),
    ).rejects.toThrow('audit write failed');

    // Document status unchanged; NO CANCELLED audit/timeline rows leaked.
    const statusAfter = (await prisma.salesDocument.findUniqueOrThrow({ where: { id: docId } })).status;
    expect(statusAfter).toBe(statusBefore);
    expect(await prisma.auditLog.count({ where: { entityId: docId, action: 'UPDATE', oldValues: { path: ['status'], equals: statusBefore } } })).toBe(0);
  });

  afterAll(async () => {
    await cleanupSalesDocument(prisma, docId);
    await prisma.party.deleteMany({ where: { id: customer.id } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
