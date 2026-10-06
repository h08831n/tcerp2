import { PrismaClient } from '@prisma/client';
import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, disconnectIntegrationPrisma } from '../testing/integration';
import {
  adminUserId,
  salesService,
  purchaseService,
  allocationsService,
  createParty,
  createVariant,
  cleanupSalesDocument,
  cleanupPurchaseDocument,
} from '../testing/p4-fixtures';

/**
 * p4-33 restart-persistence: documents, lines and allocations written by
 * one PrismaClient are read back unchanged by a COMPLETELY NEW client —
 * a backend restart loses nothing.
 */
describeIntegration('p4-33 restart persistence', () => {
  const prisma = integrationPrisma();
  const marker = `p4q${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let supplier = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let saleId = '';
  let purchaseId = '';
  let fresh: PrismaClient | null = null;

  it('documents + lines + allocations survive a fresh client (restart)', async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], `${marker}-C`);
    supplier = await createParty(prisma, ['SUPPLIER'], `${marker}-S`);
    variant = await createVariant(prisma, marker);

    const sales = salesService(prisma);
    const purchase = purchaseService(prisma);
    const allocations = allocationsService(prisma);

    const doc = await sales.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id, lines: [{ productVariantId: variant.variantId, quantity: 5, unitPrice: 1000 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    saleId = doc.id;

    const po = await purchase.create(
      INTEGRATION_COMPANY_ID,
      { supplierPartyId: supplier.id, lines: [{ productVariantId: variant.variantId, quantity: 10, unitPrice: 800 }] },
      { id: actorId, username: 'admin' },
      {},
    );
    purchaseId = po.id;

    const allocation = await allocations.create(
      INTEGRATION_COMPANY_ID,
      { salesLineId: doc.lines[0].id, purchaseLineId: po.lines[0].id, allocatedQuantity: 5 },
      { id: actorId, username: 'admin' },
      {},
    );

    // "Restart": a brand-new PrismaClient instance.
    fresh = new PrismaClient();
    const rereadDoc = await fresh.salesDocument.findUniqueOrThrow({
      where: { id: saleId },
      include: { lines: true },
    });
    expect(rereadDoc.documentNumber).toBe(doc.documentNumber);
    expect(rereadDoc.lines).toHaveLength(1);
    expect(Number(rereadDoc.lines[0].orderedQuantity)).toBe(5);

    const rereadPo = await fresh.purchaseDocument.findUniqueOrThrow({
      where: { id: purchaseId },
      include: { lines: true },
    });
    expect(rereadPo.lines).toHaveLength(1);
    expect(Number(rereadPo.lines[0].orderedQuantity)).toBe(10);

    const rereadAllocation = await fresh.salesPurchaseAllocation.findUniqueOrThrow({
      where: { id: allocation.id },
    });
    expect(Number(rereadAllocation.allocatedQuantity)).toBe(5);
    expect(rereadAllocation.companyId).toBe(INTEGRATION_COMPANY_ID);
  });

  afterAll(async () => {
    if (fresh) await fresh.$disconnect();
    await cleanupSalesDocument(prisma, saleId);
    await cleanupPurchaseDocument(prisma, purchaseId);
    await prisma.party.deleteMany({ where: { id: { in: [customer.id, supplier.id] } } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
