import { Prisma } from '@prisma/client';
import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';

/**
 * p3a-04 — multi-role-party: one party may hold CUSTOMER + SUPPLIER + DRIVER
 * simultaneously; a duplicate (partyId, role) pair is rejected.
 */
describe('p3a-04 multi-role-party', () => {
  const COMPANY = 'company-1';

  function makeService() {
    const trx = {
      party: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'party-1',
          ...args.data,
        })),
      },
      partyRole: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'role-1',
          ...args.data,
        })),
      },
      timelineEvent: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      partyPhone: { findFirst: jest.fn(async () => null) },
      $queryRaw: jest.fn(async () => []),
      user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const timeline = new TimelineService(prisma as never);
    const service = new PartiesService(prisma as never, { record: jest.fn() } as never, timeline);
    return { service, trx };
  }

  it('creates one party with several simultaneous roles', async () => {
    const { service, trx } = makeService();
    await service.create(
      COMPANY,
      {
        type: 'PERSON',
        nameFa: 'علی رضایی',
        roles: ['CUSTOMER', 'SUPPLIER', 'DRIVER'],
      },
      { id: 'u1', username: 'sales' },
      {},
    );

    const roles = (
      trx.party.create.mock.calls[0][0].data as { roles: { create: unknown[] } }
    ).roles.create;
    expect(roles).toEqual([{ role: 'CUSTOMER' }, { role: 'SUPPLIER' }, { role: 'DRIVER' }]);
  });

  it('deduplicates repeated roles from client input', async () => {
    const { service, trx } = makeService();
    await service.create(
      COMPANY,
      {
        type: 'PERSON',
        nameFa: 'علی رضایی',
        roles: ['CUSTOMER', 'CUSTOMER', 'DRIVER'],
      },
      { id: 'u1', username: 'sales' },
      {},
    );
    const roles = (
      trx.party.create.mock.calls[0][0].data as { roles: { create: unknown[] } }
    ).roles.create;
    expect(roles).toEqual([{ role: 'CUSTOMER' }, { role: 'DRIVER' }]);
  });

  it('rejects adding a role the party already holds (ROLE_EXISTS)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
    });
    p2002.meta = { target: ['party_roles_party_id_role_key'] };

    const trx = {
      partyRole: {
        create: jest.fn(async () => {
          throw p2002;
        }),
      },
      timelineEvent: { create: jest.fn() },
    };
    const prisma = {
      party: {
        findUnique: jest.fn(async () => ({
          id: 'party-1',
          companyId: COMPANY,
          ownerUserId: 'u1',
          version: 1,
        })),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
      teamMember: { findMany: jest.fn(async () => []) },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn() } as never,
      new TimelineService(prisma as never),
    );

    await expect(
      service.addRole(
        COMPANY,
        { userId: 'u1', scope: 'ALL' },
        'party-1',
        { role: 'CUSTOMER' },
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'ROLE_EXISTS' });
  });
});
