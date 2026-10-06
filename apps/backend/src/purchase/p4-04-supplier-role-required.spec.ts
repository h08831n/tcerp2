import { assertSupplier } from '../common/utils/party-roles';
import { ValidationError } from '../common/errors';

/**
 * p4-04 supplier-role-required: purchase documents require a party holding
 * the SUPPLIER role — otherwise ValidationError NOT_A_SUPPLIER.
 */
describe('p4-04 supplier-role-required', () => {
  function makePrisma(party: { id: string; roles: { id: string }[] } | null) {
    return {
      party: {
        findFirst: jest.fn(async (args: unknown) => {
          const a = args as { where: { id: string } };
          if (party && a.where.id === party.id) return party;
          return null;
        }),
      },
    };
  }

  it('a party WITHOUT the SUPPLIER role → ValidationError NOT_A_SUPPLIER', async () => {
    const prisma = makePrisma({ id: 'sp1', roles: [] });
    await expect(assertSupplier(prisma as never, 'c1', 'sp1')).rejects.toMatchObject({
      statusCode: 422,
      message: 'NOT_A_SUPPLIER',
    });
  });

  it('a CUSTOMER-only party is not a supplier', async () => {
    // The service query filters roles to SUPPLIER — a CUSTOMER-only party
    // yields an empty roles list.
    const prisma = makePrisma({ id: 'sp2', roles: [] });
    await expect(assertSupplier(prisma as never, 'c1', 'sp2')).rejects.toMatchObject({
      message: 'NOT_A_SUPPLIER',
    });
  });

  it('a cross-company party is treated as missing → NOT_A_SUPPLIER', async () => {
    const prisma = makePrisma(null);
    await expect(assertSupplier(prisma as never, 'company-b', 'sp-elsewhere')).rejects.toMatchObject({
      message: 'NOT_A_SUPPLIER',
    });
  });

  it('a real SUPPLIER passes', async () => {
    const prisma = makePrisma({ id: 'sp3', roles: [{ id: 'r1' }] });
    await expect(assertSupplier(prisma as never, 'c1', 'sp3')).resolves.toBeUndefined();
  });
});
