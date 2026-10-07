import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  salesService,
  purchaseService,
  createParty,
  createVariant,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4c-01 notes persistence (Phase 4 corrective pass): header `notes` and
 * per-line `notes`/`printableDescription` are STORED on sales + purchase
 * documents. Printing uses the stored printable text — editing it never
 * touches the product master (template/variant nameFa).
 *
 * Header notes arrive via the optimistic PATCH (CreateSalesDocumentDto /
 * CreatePurchaseDocumentDto carry no header notes — notes is a header PATCH
 * field, editable even on confirmed orders).
 */
describeIntegration('p4c-01 notes persist on headers + lines; printable edit leaves the master alone', () => {
  const prisma = integrationPrisma();
  const marker = `p4c1${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let salesDocId = '';
  let purchaseDocId = '';

  const salesCtx = () => ({
    actorScope: { userId: actorId, scope: 'ALL' as const },
    teamUserIds: [],
    canOverrideConfirmedOrder: false,
  });

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-C`);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-S`);
    variant = await createVariant(prisma, marker);
  });

  it('sales: line notes + custom printableDescription stored at create; header notes persisted by PATCH (audit old/new)', async () => {
    const sales = salesService(prisma);
    const LINE_NOTES = 'یادداشت خط فروش — تحویل شاخه ۱۲ متری';
    const CUSTOM_PRINT = 'میلگرد آجدار ذوب آهن سایز ۱۶ گرید A3 شاخه ۱۲ متری';

    const doc = await sales.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      {
        customerPartyId: customer.id,
        lines: [
          {
            productVariantId: variant.variantId,
            quantity: 10,
            unitPrice: 1000,
            notes: LINE_NOTES,
            printableDescription: CUSTOM_PRINT,
          },
        ],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    salesDocId = doc.id;

    expect(doc.lines).toHaveLength(1);
    expect(doc.lines[0].notes).toBe(LINE_NOTES);
    expect(doc.lines[0].printableDescription).toBe(CUSTOM_PRINT);

    // Header notes via optimistic PATCH — twice so the audit row carries old AND new.
    const HEADER_NOTES_1 = 'یادداشت هدر فروش — نسخه اول';
    const HEADER_NOTES_2 = 'یادداشت هدر فروش — نسخه دوم';
    const patched = await sales.update(
      INTEGRATION_COMPANY_ID,
      salesCtx(),
      doc.id,
      { version: doc.version, notes: HEADER_NOTES_1 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(patched.notes).toBe(HEADER_NOTES_1);

    const repatched = await sales.update(
      INTEGRATION_COMPANY_ID,
      salesCtx(),
      doc.id,
      { version: patched.version, notes: HEADER_NOTES_2 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(repatched.notes).toBe(HEADER_NOTES_2);

    // The header UPDATE audit row records the old AND new notes.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'sales_document', entityId: doc.id, action: 'UPDATE' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const last = audits[audits.length - 1];
    expect((last.oldValues as { notes?: string | null }).notes).toBe(HEADER_NOTES_1);
    expect((last.newValues as { notes?: string | null }).notes).toBe(HEADER_NOTES_2);

    // Editing the printable description changes the STORED value only.
    const EDITED_PRINT = 'متن چاپی ویرایش‌شده توسط کاربر';
    const edited = await sales.updateLine(
      INTEGRATION_COMPANY_ID,
      salesCtx(),
      doc.id,
      doc.lines[0].id,
      { printableDescription: EDITED_PRINT },
      { id: actorId, username: 'admin' },
      {},
    );
    const line = edited.lines.find((l: { id: string }) => l.id === doc.lines[0].id)!;
    expect(line.printableDescription).toBe(EDITED_PRINT);

    // The product master is untouched — printing uses the stored value.
    const master = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.variantId } });
    expect(master.nameFa).not.toBe(EDITED_PRINT);
  });

  it('purchase: header notes persisted by PATCH (create + update), line notes stored at create', async () => {
    const purchase = purchaseService(prisma);
    const PO_LINE_NOTES = 'یادداشت خط خرید — بارگیری صبح';

    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [{ productVariantId: variant.variantId, quantity: 4, unitPrice: 900, notes: PO_LINE_NOTES }],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    purchaseDocId = po.id;

    expect(po.lines[0].notes).toBe(PO_LINE_NOTES);

    const PO_NOTES_1 = 'یادداشت هدر خرید — نسخه اول';
    const patched = await purchase.update(
      INTEGRATION_COMPANY_ID,
      po.id,
      { version: po.version, notes: PO_NOTES_1 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(patched.notes).toBe(PO_NOTES_1);

    const PO_NOTES_2 = 'یادداشت هدر خرید — نسخه دوم';
    const repatched = await purchase.update(
      INTEGRATION_COMPANY_ID,
      patched.id,
      { version: patched.version, notes: PO_NOTES_2 },
      { id: actorId, username: 'admin' },
      {},
    );
    expect(repatched.notes).toBe(PO_NOTES_2);

    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'purchase_document', entityId: po.id, action: 'UPDATE' },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(2);
    const last = audits[audits.length - 1];
    expect((last.oldValues as { notes?: string | null }).notes).toBe(PO_NOTES_1);
    expect((last.newValues as { notes?: string | null }).notes).toBe(PO_NOTES_2);
  });

  afterAll(async () => {
    // Cleanup runs even when an assertion failed mid-test (no orphaned docs
    // may keep the party/variant deletes from running).
    if (salesDocId) await cleanupSalesDocument(prisma, salesDocId);
    if (purchaseDocId) await cleanupPurchaseDocument(prisma, purchaseDocId);
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
