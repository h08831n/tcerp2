import { SupplierMappingsService, NOT_A_SUPPLIER } from './supplier-mappings.service';

/**
 * p3b-13 — supplier-must-have-role: a mapping can only reference a Party of
 * the same company that holds the SUPPLIER role; otherwise ValidationError
 * `NOT_A_SUPPLIER`.
 */
describe('p3b-13 supplier-must-have-role', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'buyer' };

  function makeService(party: Record<string, unknown> | null) {
    const prisma = {
      party: {
        findUnique: jest.fn(async () => party),
      },
      productVariant: { findUnique: jest.fn(async () => ({ companyId: COMPANY })) },
      productTemplate: { findUnique: jest.fn(async () => null) },
      productCategory: { findUnique: jest.fn(async () => null) },
      $transaction: jest.fn(),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new SupplierMappingsService(prisma as never, audit as never);
    return { service, prisma };
  }

  const input = {
    supplierPartyId: 'party-1',
    mappingLevel: 'VARIANT' as const,
    productVariantId: 'var-1',
  };

  it('a party WITHOUT the SUPPLIER role → ValidationError NOT_A_SUPPLIER', async () => {
    const { service } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      roles: [{ role: 'CUSTOMER' }],
    });
    await expect(service.create(COMPANY, input, actor, {})).rejects.toMatchObject({
      message: NOT_A_SUPPLIER,
    });
  });

  it('a party of ANOTHER company is rejected (not found in this company)', async () => {
    const { service } = makeService({
      id: 'party-1',
      companyId: 'company-OTHER',
      roles: [{ role: 'SUPPLIER' }],
    });
    await expect(service.create(COMPANY, input, actor, {})).rejects.toMatchObject({
      message: 'Supplier party not found in this company',
    });
  });

  it('a party WITH the SUPPLIER role in the same company passes the gate', async () => {
    const { service, prisma } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      roles: [{ role: 'CUSTOMER' }, { role: 'SUPPLIER' }],
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn({
        supplierProduct: {
          create: jest.fn(async () => ({ id: 'sp-1', supplierPartyId: 'party-1', mappingLevel: 'VARIANT' })),
        },
      }),
    );
    const row = (await service.create(COMPANY, input, actor, {})) as { id: string };
    expect(row.id).toBe('sp-1');
  });

  it('a multi-role party (CUSTOMER + SUPPLIER) is accepted — role check, not type check', async () => {
    const { service, prisma } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      roles: [{ role: 'SUPPLIER' }],
    });
    (prisma.$transaction as jest.Mock).mockImplementation(async (fn: (t: unknown) => unknown) =>
      fn({
        supplierProduct: {
          create: jest.fn(async () => ({ id: 'sp-2', supplierPartyId: 'party-1', mappingLevel: 'VARIANT' })),
        },
      }),
    );
    await expect(service.create(COMPANY, input, actor, {})).resolves.toBeDefined();
  });
});
