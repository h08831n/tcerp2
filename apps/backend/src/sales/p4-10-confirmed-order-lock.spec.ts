import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import {
  adminUserId,
  salesService,
  createParty,
  createVariant,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';

/**
 * p4-10 confirmed-order-locked-normal-user
 * p4-11 backend-rejects-locked-field-edit (403 ORDER_LOCKED)
 * p4-12 manager-override-with-reason (needs the permission AND a reason)
 * p4-13 override-audit-atomicity (audit fail → rollback; success → old/new/reason)
 * p4-14 version-conflict (409 VERSION_CONFLICT)
 *
 * (REQUIREMENTS §9 Confirmed Order Lock.)
 */
describeIntegration('p4-10..p4-14 confirmed-order lock + override + optimistic version', () => {
  const prisma = integrationPrisma();
  const marker = `p4f${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let docId = '';
  let lineId = '';

  const ctx = (canOverride: boolean) => ({
    actorScope: { userId: actorId, scope: 'ALL' as const },
    teamUserIds: [],
    canOverrideConfirmedOrder: canOverride,
  });

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
    const service = salesService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      {
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 1000000 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    docId = doc.id;
    lineId = doc.lines[0].id;
    await service.confirm(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, docId, { id: actorId, username: 'admin' }, {});
  });

  it('p4-11/p4-10: locked-field edit without sales.override_confirmed_order → 403 ORDER_LOCKED', async () => {
    const service = salesService(prisma);
    await expect(
      service.updateLine(
        INTEGRATION_COMPANY_ID,
        ctx(false),
        docId,
        lineId,
        { quantity: 99 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403, message: 'ORDER_LOCKED' });
  });

  it('p4-12a: override WITH the permission but WITHOUT a reason → 422 OVERRIDE_REASON_REQUIRED', async () => {
    const service = salesService(prisma);
    await expect(
      service.updateLine(
        INTEGRATION_COMPANY_ID,
        ctx(true),
        docId,
        lineId,
        { quantity: 99 },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'OVERRIDE_REASON_REQUIRED' });
  });

  it('p4-12b: override with permission + reason succeeds (old 10 → new 99)', async () => {
    const service = salesService(prisma);
    const result = await service.updateLine(
      INTEGRATION_COMPANY_ID,
      ctx(true),
      docId,
      lineId,
      { quantity: 99, overrideReason: 'تغییر توسط مدیر فروش — توافق تلفنی مشتری' },
      { id: actorId, username: 'admin' },
      {},
    );
    const line = result.lines.find((l: { id: string }) => l.id === lineId)!;
    expect(Number(line.orderedQuantity)).toBe(99);
  });

  it('p4-13: the override audit row carries old/new values + reason, and an audit failure rolls the line back', async () => {
    // Success side: the OVERRIDE_CONFIRMED_ORDER audit row exists with reason + old/new.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'sales_document', entityId: docId, action: 'OVERRIDE_CONFIRMED_ORDER' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const entry = audits[audits.length - 1];
    expect(entry.reason).toContain('مدیر فروش');
    expect((entry.oldValues as { orderedQuantity?: string }).orderedQuantity).toBeDefined();
    expect((entry.newValues as { orderedQuantity?: string }).orderedQuantity).toBeDefined();

    // Atomicity side: an injected audit failure rolls the whole edit back.
    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValueOnce(new Error('audit write failed'));
    const failing = salesService(prisma);
    (failing as unknown as { auditService: AuditService }).auditService = audit;
    const before = await prisma.salesLine.findUniqueOrThrow({ where: { id: lineId } });
    await expect(
      failing.updateLine(
        INTEGRATION_COMPANY_ID,
        ctx(true),
        docId,
        lineId,
        { quantity: 123, overrideReason: 'هرگز ذخیره نشود' },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toThrow('audit write failed');
    const after = await prisma.salesLine.findUniqueOrThrow({ where: { id: lineId } });
    expect(Number(after.orderedQuantity)).toBe(Number(before.orderedQuantity)); // rolled back
  });

  it('p4-14: PATCH with a stale version → 409 VERSION_CONFLICT', async () => {
    const service = salesService(prisma);
    const doc = await service.getById(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, docId);
    await expect(
      service.update(
        INTEGRATION_COMPANY_ID,
        ctx(false),
        docId,
        { version: doc.version - 1, notes: 'استال' },
        { id: actorId, username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 409, message: 'VERSION_CONFLICT' });
  });

  it('header fields (expiration/paymentTerm/notes/shippingAddress) stay editable on a confirmed order', async () => {
    const service = salesService(prisma);
    const doc = await service.getById(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, docId);
    const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const result = await service.update(
      INTEGRATION_COMPANY_ID,
      ctx(false),
      docId,
      { version: doc.version, expirationDate: future },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(new Date(result.expirationDate as unknown as string).getTime()).toBe(new Date(future).getTime());
  });

  afterAll(async () => {
    await cleanupSalesDocument(prisma, docId);
    await prisma.party.deleteMany({ where: { id: customer.id } });
    await disconnectIntegrationPrisma();
  });
});
