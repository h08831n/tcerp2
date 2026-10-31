import {
  describeIntegration,
  disconnectIntegrationPrisma,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from './timeline.service';
import { PartiesService } from './parties.service';
import {
  adminUserId,
  createParty,
  createVariant,
  salesService,
  purchaseService,
  priceRequestService,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';
import { loadingService } from '../testing/p6-fixtures';

/**
 * Party timeline carries OLD→NEW values for EVERY mutation that touches the
 * party or its documents: party field edits (the owner's reported gap —
 * editing the یادداشت must show what changed), contacts, sales header/lines,
 * purchase header, price requests, loadings. `changes` = { field: {old,new} }.
 */
describeIntegration('party timeline old/new values', () => {
  const prisma = integrationPrisma();
  const marker = `oldnew-${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant: { variantId: string } = { variantId: '' };
  const parties = () =>
    new PartiesService(
      prisma as never,
      new AuditService(prisma as never),
      new TimelineService(prisma as never),
    );

  async function latestEvent(type: string, entityId: string) {
    return prisma.timelineEvent.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, entityType: 'PARTY', entityId, type },
      orderBy: { createdAt: 'desc' },
    });
  }

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
  });

  it('PARTY note edit records old and new value (the reported gap)', async () => {
    const row = await prisma.party.findUniqueOrThrow({ where: { id: customer.id } });
    await prisma.party.update({ where: { id: customer.id }, data: { notes: 'یادداشت قبلی' } });

    await parties().update(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      customer.id,
      { version: row.version, notes: 'یادداشت جدید' } as never,
      { canChangeOwner: false },
      { id: actorId, username: 'admin' },
      {},
    );

    const event = await latestEvent('PARTY_UPDATED', customer.id);
    const changes = (event.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    expect(changes.notes).toEqual({ old: 'یادداشت قبلی', new: 'یادداشت جدید' });
    // Unchanged fields are NOT listed.
    expect(changes.nameFa).toBeUndefined();
  });

  it('CONTACT edit records old and new value', async () => {
    const contact = await prisma.contact.create({
      data: { companyId: INTEGRATION_COMPANY_ID, partyId: customer.id, name: 'رابط قبلی' },
    });
    await parties().updateContact(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      customer.id,
      contact.id,
      { name: 'رابط جدید' } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    const event = await latestEvent('CONTACT_UPDATED', customer.id);
    const changes = (event.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    expect(changes.name).toEqual({ old: 'رابط قبلی', new: 'رابط جدید' });
  });

  it('sales header + line edits record old/new; line removal snapshots the removed values', async () => {
    const service = salesService(prisma);
    const actorCtx = {
      actorScope: { userId: actorId, scope: 'ALL' as const },
      teamUserIds: [] as string[],
      canOverrideConfirmedOrder: false,
    };
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      actorCtx.actorScope,
      {
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, quantity: 2, unitPrice: 100 }],
      } as never,
      { id: actorId, username: 'admin' },
      {},
    );

    await service.update(
      INTEGRATION_COMPANY_ID,
      actorCtx,
      doc.id,
      { version: doc.version, notes: 'سربرگ جدید' } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    const headerEvent = await latestEvent('SALES_DOCUMENT_UPDATED', customer.id);
    const headerChanges = (headerEvent.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    expect(headerChanges.notes).toEqual({ old: null, new: 'سربرگ جدید' });
    expect((headerEvent.data as { salesDocumentId: string }).salesDocumentId).toBe(doc.id);

    const lineId = (doc as unknown as { lines: { id: string }[] }).lines[0].id;
    await service.updateLine(
      INTEGRATION_COMPANY_ID,
      actorCtx,
      doc.id,
      lineId,
      { quantity: 5 } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    const lineEvent = await latestEvent('SALES_LINE_UPDATED', customer.id);
    const lineChanges = (lineEvent.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    // Decimal columns serialize as strings through the timeline JSON.
    expect(String(lineChanges.orderedQuantity.old)).toBe('2');
    expect(String(lineChanges.orderedQuantity.new)).toBe('5');

    await service.deleteLine(
      INTEGRATION_COMPANY_ID,
      actorCtx,
      doc.id,
      lineId,
      { id: actorId, username: 'admin' },
      {},
    );
    const removedEvent = await latestEvent('SALES_LINE_REMOVED', customer.id);
    const removed = (removedEvent.data as { removed: { orderedQuantity: unknown } }).removed;
    expect(String(removed.orderedQuantity)).toBe('5');

    await cleanupSalesDocument(prisma, doc.id);
  });

  it('purchase header edit records old and new value', async () => {
    const supplier = await createParty(prisma, ['SUPPLIER'], marker);
    const service = purchaseService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [{ productVariantId: variant.variantId, quantity: 1 }],
      } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    await service.update(
      INTEGRATION_COMPANY_ID,
      doc.id,
      { version: doc.version, notes: 'خرید ویرایش‌شده' } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    const event = await latestEvent('PURCHASE_DOCUMENT_UPDATED', supplier.id);
    const changes = (event.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    expect(changes.notes).toEqual({ old: null, new: 'خرید ویرایش‌شده' });
    await cleanupPurchaseDocument(prisma, doc.id);
    await prisma.party.deleteMany({ where: { id: supplier.id } });
  });

  it('price-request edit records old and new value on the party timeline', async () => {
    const service = priceRequestService(prisma);
    const request = await service.create(
      INTEGRATION_COMPANY_ID,
      {
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, requestedQuantity: 3 }],
      } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    await service.update(
      INTEGRATION_COMPANY_ID,
      request.id,
      { version: request.version, notes: 'استعلام ویرایش‌شده' } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    const event = await latestEvent('PRICE_REQUEST_UPDATED', customer.id);
    const changes = (event.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    expect(changes.notes).toEqual({ old: null, new: 'استعلام ویرایش‌شده' });

    await prisma.priceRequestLine.deleteMany({ where: { priceRequestId: request.id } });
    await prisma.priceRequest.deleteMany({ where: { id: request.id } });
  });

  it('draft loading edit records old and new value', async () => {
    const loading = await prisma.loading.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        loadingDate: new Date(),
        customerPartyId: customer.id,
        notes: 'بارگیری قبلی',
        createdBy: actorId,
      },
    });
    await loadingService(prisma).update(
      INTEGRATION_COMPANY_ID,
      loading.id,
      { notes: 'بارگیری جدید' } as never,
      { id: actorId, username: 'admin' },
      {},
    );
    const event = await latestEvent('LOADING_UPDATED', customer.id);
    const changes = (event.data as { changes: Record<string, { old: unknown; new: unknown }> }).changes;
    expect(changes.notes).toEqual({ old: 'بارگیری قبلی', new: 'بارگیری جدید' });
    await prisma.loading.deleteMany({ where: { id: loading.id } });
  });

  afterAll(async () => {
    await prisma.timelineEvent.deleteMany({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        OR: [
          { entityType: 'PARTY', entityId: customer.id },
          { entityType: 'PRICE_REQUEST', entityId: customer.id },
        ],
      },
    });
    // Thorough party teardown: documents may survive the in-test cleanup
    // (silent catch) — re-delete lines/allocations/docs before the party.
    const salesDocIds = (
      await prisma.salesDocument.findMany({ where: { customerPartyId: customer.id }, select: { id: true } })
    ).map((d) => d.id);
    await prisma.salesPurchaseAllocation.deleteMany({ where: { salesLine: { salesDocumentId: { in: salesDocIds } } } });
    await prisma.salesLine.deleteMany({ where: { salesDocumentId: { in: salesDocIds } } });
    await prisma.salesDocument.deleteMany({ where: { id: { in: salesDocIds } } });
    const purchaseDocIds = (
      await prisma.purchaseDocument.findMany({ where: { supplierPartyId: customer.id }, select: { id: true } })
    ).map((d) => d.id);
    await prisma.salesPurchaseAllocation.deleteMany({ where: { purchaseLine: { purchaseDocumentId: { in: purchaseDocIds } } } });
    await prisma.purchaseLine.deleteMany({ where: { purchaseDocumentId: { in: purchaseDocIds } } });
    await prisma.purchaseDocument.deleteMany({ where: { id: { in: purchaseDocIds } } });
    await prisma.contact.deleteMany({ where: { partyId: customer.id } });
    await prisma.party.deleteMany({ where: { id: customer.id } });
    await disconnectIntegrationPrisma();
  });
});
