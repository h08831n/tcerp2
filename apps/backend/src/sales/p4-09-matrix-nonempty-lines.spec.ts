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
  addVariantValues,
  cleanupSalesDocument,
} from '../testing/p4-fixtures';

/**
 * p4-09 matrix-nonempty-lines-only: POST lines/matrix creates ONE SalesLine
 * per NON-EMPTY cell — empty cells (no quantity or quantity ≤ 0) are never
 * turned into lines — and the printable description defaults to
 * «<template nameFa> <attribute valueFa ' / ' …>».
 */
describeIntegration('p4-09 matrix non-empty cells + printable description', () => {
  const prisma = integrationPrisma();
  const marker = `p4e${Date.now()}`;
  let actorId = '';
  let customer = { id: '', nameFa: '' };
  let variant = { variantId: '', templateId: '', uomId: '', sku: '', templateNameFa: '' };
  let docId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    customer = await createParty(prisma, ['CUSTOMER'], marker);
    variant = await createVariant(prisma, marker);
    await addVariantValues(prisma, INTEGRATION_COMPANY_ID, variant.variantId, [
      { attributeName: 'سایز', valueFa: '16', displayOrder: 0 },
      { attributeName: 'گرید', valueFa: 'A3', displayOrder: 1 },
    ]);
    const service = salesService(prisma);
    const doc = await service.create(
      INTEGRATION_COMPANY_ID,
      { userId: actorId, scope: 'ALL' },
      { customerPartyId: customer.id },
      { id: actorId, username: 'admin' },
      {},
    );
    docId = doc.id;
  });

  it('empty cells are ignored; non-empty cells become exactly one line each', async () => {
    const service = salesService(prisma);
    const result = await service.createFromMatrix(
      INTEGRATION_COMPANY_ID,
      { actorScope: { userId: actorId, scope: 'ALL' }, teamUserIds: [], canOverrideConfirmedOrder: false },
      docId,
      {
        cells: [
          { productVariantId: variant.variantId }, // empty: no quantity
          { productVariantId: variant.variantId, quantity: 0 }, // empty: ≤ 0
          { productVariantId: variant.variantId, quantity: 10, unitPrice: 25000000 },
        ],
      },
      { id: actorId, username: 'admin' },
      {},
    );

    expect(result.lines).toHaveLength(1);
    expect(Number(result.lines[0].orderedQuantity)).toBe(10);
    expect(Number(result.total)).toBe(250000000);
  });

  it('printableDescription defaults to «template + attribute values fa»', async () => {
    const service = salesService(prisma);
    const result = await service.createFromMatrix(
      INTEGRATION_COMPANY_ID,
      { actorScope: { userId: actorId, scope: 'ALL' }, teamUserIds: [], canOverrideConfirmedOrder: false },
      docId,
      { cells: [{ productVariantId: variant.variantId, quantity: 2, unitPrice: 1000 }] },
      { id: actorId, username: 'admin' },
      {},
    );

    const last = result.lines[result.lines.length - 1];
    expect(last.printableDescription).toContain(variant.templateNameFa);
    expect(last.printableDescription).toContain('16');
    expect(last.printableDescription).toContain('A3');
    expect(last.printableDescription).toBe(`${variant.templateNameFa} 16 / A3`);
  });

  afterAll(async () => {
    await cleanupSalesDocument(prisma, docId);
    await prisma.party.deleteMany({ where: { id: customer.id } });
    await prisma.variantAttributeValue.deleteMany({ where: { variantId: variant.variantId } });
    await prisma.productVariant.deleteMany({ where: { id: variant.variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: variant.templateId } });
    await disconnectIntegrationPrisma();
  });
});
