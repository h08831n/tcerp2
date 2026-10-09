import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  purchaseService,
  createParty,
  createVariant,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';
import { cleanupPurchaseReceive } from '../testing/p6-fixtures';

/**
 * p6-03 purchase-receive-generates-in-movements: POST receive on an
 * ORDER_PLACED purchase generates one IN movement per line into the company
 * default warehouse; the status STAYS ORDER_PLACED (receipt tracked via
 * movement existence); a second receive is a NO-OP SUCCESS (`moved: false`)
 * with no duplicate rows.
 */
describeIntegration('p6-03 purchase-receive-generates-in-movements', () => {
  const prisma = integrationPrisma();
  const marker = `p6-03-${Date.now()}`;
  let actorId = '';
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let purchaseId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    supplier = await createParty(prisma, ['SUPPLIER'], marker);
    variant = await createVariant(prisma, marker);
  });

  it('receive once → IN movements; receive again → no-op without duplicates', async () => {
    const purchase = purchaseService(prisma);
    const actor = { id: actorId, username: 'admin' };

    const created = await purchase.create(
      INTEGRATION_COMPANY_ID,
      {
        supplierPartyId: supplier.id,
        lines: [
          { productVariantId: variant.variantId, quantity: 10, unitPrice: 5000 },
          { productVariantId: variant.variantId, quantity: 5, unitPrice: 5000 },
        ],
      },
      actor,
      {},
    );
    purchaseId = created.id;
    await purchase.place(INTEGRATION_COMPANY_ID, purchaseId, actor, {});

    const first = await purchase.receive(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    expect(first.moved).toBe(true);
    expect(first.movementsCreated).toBe(2);
    expect(first.movementCount).toBe(2);
    expect(first.document.status).toBe('ORDER_PLACED'); // status unchanged by receipt

    const movements = await prisma.stockMovement.findMany({
      where: { sourceEntityType: 'PURCHASE', sourceEntityId: purchaseId },
    });
    expect(movements).toHaveLength(2);
    const lineIds = created.lines.map((line: { id: string }) => line.id);
    movements.forEach((movement) => {
      expect(movement.direction).toBe('IN');
      expect(lineIds).toContain(movement.idempotencyKey.replace(`purchase:${purchaseId}:line:`, ''));
      expect(movement.sourceEntityType).toBe('PURCHASE');
      expect(movement.companyId).toBe(INTEGRATION_COMPANY_ID);
    });

    // Second receive: no-op success, no duplicates (idempotencyKey P2002 path).
    const second = await purchase.receive(INTEGRATION_COMPANY_ID, purchaseId, actor, {});
    expect(second.moved).toBe(false);
    expect(second.movementsCreated).toBe(0);
    const afterSecond = await prisma.stockMovement.count({
      where: { sourceEntityType: 'PURCHASE', sourceEntityId: purchaseId },
    });
    expect(afterSecond).toBe(2);

    // The receipt is audited.
    const audits = await prisma.auditLog.findMany({
      where: { entityType: 'purchase_document', entityId: purchaseId, action: 'RECEIVE' },
    });
    expect(audits.length).toBeGreaterThanOrEqual(1);
  });

  afterAll(async () => {
    await cleanupPurchaseReceive(prisma, purchaseId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await disconnectIntegrationPrisma();
  });
});
