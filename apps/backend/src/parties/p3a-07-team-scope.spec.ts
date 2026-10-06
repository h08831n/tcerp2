import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';
import { scopeWhere } from './party-scope';

/**
 * p3a-07 — record scope TEAM: a sales manager holding `parties.scope.team`
 * sees parties owned by members of their own teams (and their own), but not
 * parties owned by users outside those teams.
 */
describe('p3a-07 team-scope', () => {
  const COMPANY = 'company-1';
  const MANAGER = 'user-manager';
  const TEAMMATE = 'user-teammate';
  const OUTSIDER = 'user-outsider';

  function makeService() {
    const prisma = {
      party: {
        findUnique: jest.fn(),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      // corr-04: team scope is company-scoped — the teams of COMPANY have
      // { manager, teammate } as members.
      team: {
        findMany: jest.fn(async (args: { where: { companyId: string } }) =>
          args.where.companyId === COMPANY ? [{ id: 'team-1' }] : [],
        ),
      },
      teamMember: {
        findMany: jest.fn(async (args: { where: { teamId?: { in: string[] } } }) =>
          args.where.teamId?.in?.includes('team-1')
            ? [
                { teamId: 'team-1', userId: MANAGER },
                { teamId: 'team-1', userId: TEAMMATE },
              ]
            : [],
        ),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({})),
      user: { findUnique: jest.fn(async () => ({ id: MANAGER })) },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma };
  }

  it('list: includes own + team-member owners, never outsiders', async () => {
    const { service, prisma } = makeService();
    await service.list(COMPANY, { userId: MANAGER, scope: 'TEAM' }, {} as never);

    const where = (prisma.party.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.ownerUserId).toEqual({ in: expect.arrayContaining([MANAGER, TEAMMATE]) });
    expect((where.ownerUserId as { in: string[] }).in).not.toContain(OUTSIDER);
  });

  it('teamUserIds resolves through the company’s teams only (corr-04 signature)', async () => {
    const { service, prisma } = makeService();
    const ids = await service.teamUserIds(MANAGER, COMPANY);
    expect(ids).toEqual(expect.arrayContaining([MANAGER, TEAMMATE]));
    expect(ids).not.toContain(OUTSIDER);
    // The team probe is pinned to the company.
    expect((prisma.team.findMany as jest.Mock).mock.calls[0][0].where.companyId).toBe(COMPANY);
  });

  it('get: teammate’s party is visible; outsider’s party is ForbiddenError', async () => {
    const { service } = makeService();
    (service as unknown as { prisma: { party: { findUnique: jest.Mock } } }).prisma.party.findUnique
      .mockResolvedValueOnce({
        id: 'party-teammate',
        companyId: COMPANY,
        ownerUserId: TEAMMATE,
        version: 1,
      })
      .mockResolvedValueOnce({
        id: 'party-outsider',
        companyId: COMPANY,
        ownerUserId: OUTSIDER,
        version: 1,
      });

    await expect(
      service.getById(COMPANY, { userId: MANAGER, scope: 'TEAM' }, 'party-teammate'),
    ).resolves.toBeTruthy();
    await expect(
      service.getById(COMPANY, { userId: MANAGER, scope: 'TEAM' }, 'party-outsider'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('scopeWhere TEAM merges the manager themself into the owner set', () => {
    expect(scopeWhere('TEAM', MANAGER, [TEAMMATE])).toEqual({
      ownerUserId: { in: [MANAGER, TEAMMATE] },
    });
  });
});
