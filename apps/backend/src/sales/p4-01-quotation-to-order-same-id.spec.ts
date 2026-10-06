import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  salesService,
  createParty,
  createVariant,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';

/**
 * p4-01 quotation-to-order-same-id/number + p4-02 no-second-number-on-confirm
 * (REQUIREMENTS §9): quotation and sales order are ONE SalesDocument — the
 * id and document_number never change and the sequence is allocated exactly
 * once (at creation), never again on confirm/activate.
 */
describeIntegration('p4-01/p4-02 quotation → order keeps ONE id and ONE number', () => {
  const prisma = integrationPrisma();
  const marker = `p4a${Date.now()}`;

  it('confirm/activate keep the same id + number and never re-allocate', async () => {
    const actorId = await adminUserId(prisma);
    const service = salesService(prisma);
    const customer = await createParty(prisma, ['CUSTOMER'], marker);
    const variant = await createVariant(prisma, marker, { defaultSalesPrice: '30000000' });

    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      {
        customerPartyId: customer.id,
        lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 30000000 }],
      },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(doc.documentNumber).toMatch(/^SD-\d{4}-\d{5}$/);
    const createdNumber = doc.documentNumber;

    // Sequence counter after creation…
    const seqAfterCreate = await prisma.sequence.findUniqueOrThrow({
      where: { companyId_documentType: { companyId: INTEGRATION_COMPANY_ID, documentType: 'SALES_DOCUMENT' } },
    });

    const sent = await service.send(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, doc.id, { id: actorId, username: 'admin' }, {});
    expect(sent.status).toBe('SENT');

    const confirmed = await service.confirm(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, doc.id, { id: actorId, username: 'admin' }, {});
    expect(confirmed.status).toBe('CUSTOMER_CONFIRMED');

    const activated = await service.activate(INTEGRATION_COMPANY_ID, { userId: actorId, scope: 'ALL' }, doc.id, { id: actorId, username: 'admin' }, {});
    expect(activated.status).toBe('SALES_ORDER');

    // p4-01: same id, same number through the whole transition chain.
    expect(activated.id).toBe(doc.id);
    expect(activated.documentNumber).toBe(createdNumber);

    // p4-02: the sequence counter did NOT move on send/confirm/activate.
    const seqAfterTransitions = await prisma.sequence.findUniqueOrThrow({
      where: { companyId_documentType: { companyId: INTEGRATION_COMPANY_ID, documentType: 'SALES_DOCUMENT' } },
    });
    expect(seqAfterTransitions.currentNumber).toBe(seqAfterCreate.currentNumber);

    // p4-01b: exactly ONE document was created for the marker.
    const count = await prisma.salesDocument.count({ where: { documentNumber: createdNumber } });
    expect(count).toBe(1);

    await cleanupSalesDocument(prisma, doc.id);
    await prisma.party.deleteMany({ where: { id: customer.id } });
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
