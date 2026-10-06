import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';
import { resolveRecordScope, scopeWhere } from './party-scope';

/**
 * p3a-06 — record scope OWN: a salesperson (no parties.scope.* permission)
 * sees only their own parties in the list, and reading a party owned by
 * someone else is a ForbiddenError.
 */
describe('p3a-06 own-scope', () => {
  const COMPANY = 'company-1';
  const ME = 'user-me';
  const OTHER = 'user-other';

  function makeService(partyRow: Record<string, unknown> | null) {
    const prisma = {
      party: {
        findUnique: jest.fn(async () => partyRow),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      teamMember: { findMany: jest.fn(async () => []) },
      partyPhone: { findFirst: jest.fn(async () => null) },
      $queryRaw: jest.fn(async () => []),
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({})),
      user: { findUnique: jest.fn(async () => ({ id: ME })) },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma };
  }

  it('scope convention: no scope permission → OWN', () => {
    expect(resolveRecordScope([])).toBe('OWN');
    expect(resolveRecordScope(['parties.view', 'parties.create'])).toBe('OWN');
    expect(resolveRecordScope(['parties.scope.team'])).toBe('TEAM');
    expect(resolveRecordScope(['parties.scope.team', 'parties.scope.all'])).toBe('ALL');
  });

  it('list: the SQL where clause pins ownerUserId to the current user', async () => {
    const { service, prisma } = makeService(null);
    await service.list(COMPANY, { userId: ME, scope: 'OWN' }, {} as never);

    const where = (prisma.party.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: COMPANY, ownerUserId: ME });
  });

  it('list: OWN scope never widens through team membership', async () => {
    const { service, prisma } = makeService(null);
    await service.list(COMPANY, { userId: ME, scope: 'OWN' }, {} as never);
    expect(prisma.teamMember.findMany).not.toHaveBeenCalled();
    expect(scopeWhere('OWN', ME, [OTHER])).toEqual({ ownerUserId: ME });
  });

  it('get: another salesperson’s party → ForbiddenError', async () => {
    const { service } = makeService({
      id: 'party-x',
      companyId: COMPANY,
      ownerUserId: OTHER,
      version: 1,
    });
    await expect(
      service.getById(COMPANY, { userId: ME, scope: 'OWN' }, 'party-x'),
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('get: own party passes', async () => {
    const { service } = makeService({
      id: 'party-mine',
      companyId: COMPANY,
      ownerUserId: ME,
      version: 1,
    });
    await expect(
      service.getById(COMPANY, { userId: ME, scope: 'OWN' }, 'party-mine'),
    ).resolves.toBeTruthy();
  });

  it('update: out-of-scope party is rejected before any write', async () => {
    const { service, prisma } = makeService({
      id: 'party-x',
      companyId: COMPANY,
      ownerUserId: OTHER,
      version: 3,
    });
    await expect(
      service.update(
        COMPANY,
        { userId: ME, scope: 'OWN' },
        'party-x',
        { version: 3, nameFa: 'هک' },
        { canChangeOwner: false },
        { id: ME, username: 'me' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    // No write path was reached (no transaction started).
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
