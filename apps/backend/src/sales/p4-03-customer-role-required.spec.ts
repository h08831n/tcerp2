import { assertCustomer } from '../common/utils/party-roles';
import { ValidationError } from '../common/errors';

/**
 * p4-03 customer-role-required: a party without the CUSTOMER role (or a
 * cross-company party) is rejected with ValidationError NOT_A_CUSTOMER
 * before any sales document is created.
 */
describe('p4-03 customer-role-required', () => {
  function makePrisma(party: { id: string; roles: { id: string }[] } | null) {
    // Emulates the filtered relation: roles are pre-filtered to the
    // requested role by the service query.
    return {
      party: {
        findFirst: jest.fn(async (args: unknown) => {
          const a = args as { where: { id: string; roles?: { where?: { role?: string } } } };
          if (!party || a.where.id !== party.id) return null;
          return party;
        }),
      },
    };
  }

  it('a party WITHOUT the CUSTOMER role → ValidationError NOT_A_CUSTOMER', async () => {
    const prisma = makePrisma({ id: 'p1', roles: [] });
    await expect(assertCustomer(prisma as never, 'c1', 'p1')).rejects.toMatchObject({
      statusCode: 422,
      message: 'NOT_A_CUSTOMER',
    });
  });

  it('a party holding another role (e.g. SUPPLIER) only → NOT_A_CUSTOMER', async () => {
    // The service query filters roles to CUSTOMER — a SUPPLIER-only party
    // yields an empty roles list.
    const prisma = makePrisma({ id: 'p2', roles: [] });
    await expect(assertCustomer(prisma as never, 'c1', 'p2')).rejects.toMatchObject({
      message: 'NOT_A_CUSTOMER',
    });
  });

  it('a cross-company party is treated as missing → NOT_A_CUSTOMER', async () => {
    const prisma = makePrisma(null);
    await expect(assertCustomer(prisma as never, 'company-b', 'p-elsewhere')).rejects.toMatchObject({
      message: 'NOT_A_CUSTOMER',
    });
  });

  it('a real CUSTOMER passes', async () => {
    const prisma = makePrisma({ id: 'p3', roles: [{ id: 'r1' }, { id: 'r2' }] });
    await expect(assertCustomer(prisma as never, 'c1', 'p3')).resolves.toBeUndefined();
  });

  it('the error is a ValidationError (422 envelope)', () => {
    const err = new ValidationError('NOT_A_CUSTOMER');
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('NOT_A_CUSTOMER');
  });
});
