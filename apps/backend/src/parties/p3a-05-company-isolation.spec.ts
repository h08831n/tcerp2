import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';
import { resolveRecordScope } from './party-scope';

/**
 * p3a-05 — company-isolation: a party of company A is invisible (404
 * semantics) to a company-B context in get/update/sub-resource paths, and
 * every query carries the companyId filter.
 */
describe('p3a-05 company-isolation', () => {
  const COMPANY_A = '00000000-0000-4000-8000-000000000001';
  const COMPANY_B = '00000000-0000-4000-8000-000000000002';

  function makeService(partyRow: Record<string, unknown> | null) {
    const prisma = {
      party: {
        findUnique: jest.fn(async () => partyRow),
        findFirst: jest.fn(async () => partyRow),
      },
      teamMember: { findMany: jest.fn(async () => []) },
      partyPhone: { findFirst: jest.fn(async () => null) },
      $queryRaw: jest.fn(async () => []),
      user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({})),
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma };
  }

  const partyOfA = {
    id: 'party-a1',
    companyId: COMPANY_A,
    ownerUserId: 'u1',
    version: 1,
    nameFa: 'شرکت الف',
  };

  it('getById: company B gets NotFoundError (not Forbidden) for a party of company A', async () => {
    const { service } = makeService(partyOfA);
    await expect(
      service.getById(COMPANY_B, { userId: 'u1', scope: resolveRecordScope([]) }, 'party-a1'),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('getById: full detail is returned inside the owning company', async () => {
    const { service } = makeService(partyOfA);
    await expect(
      service.getById(COMPANY_A, { userId: 'u1', scope: 'ALL' }, 'party-a1'),
    ).resolves.toBeTruthy();
  });

  it('update: company B cannot modify a party of company A', async () => {
    const { service } = makeService(partyOfA);
    await expect(
      service.update(
        COMPANY_B,
        { userId: 'u1', scope: 'ALL' },
        'party-a1',
        { version: 1, nameFa: 'تلاش نفوذ' },
        { canChangeOwner: false },
        { id: 'u1', username: 'b-user' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('checkDuplicate never looks beyond the requesting company', async () => {
    const { service, prisma } = makeService(null);
    await service.checkDuplicate(COMPANY_B, { mobile: '09121112233' });
    const where = (prisma.partyPhone.findFirst as jest.Mock).mock.calls[0][0].where;
    expect(where.companyId).toBe(COMPANY_B);
  });
});
