import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
  testUuid,
} from '../testing/integration';

/**
 * corr-04 — team scope is COMPANY-SCOPED: teamUserIds(userId, companyId) only
 * lets teams with team.company_id = companyId contribute members (the user is
 * a member or the manager of those teams). A teammate from a team of company
 * A does NOT become visible through TEAM scope inside company B.
 */
describe('corr-04 team-scope-company-scoped', () => {
  const COMPANY_A = 'company-A';
  const COMPANY_B = 'company-B';
  const U = 'user-u';
  const TEAMMATE_A = 'user-teammate-a';
  const TEAMMATE_B = 'user-teammate-b';

  function makeService() {
    const prisma = {
      party: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        findUnique: jest.fn(async () => null),
      },
      // U is a member of team-A (company A) and team-B (company B).
      team: {
        findMany: jest.fn(async (args: { where: { companyId: string } }) =>
          args.where.companyId === COMPANY_A
            ? [{ id: 'team-A' }]
            : args.where.companyId === COMPANY_B
              ? [{ id: 'team-B' }]
              : [],
        ),
      },
      teamMember: {
        findMany: jest.fn(async (args: { where: { teamId: { in: string[] } } }) =>
          args.where.teamId.in.includes('team-A')
            ? [
                { teamId: 'team-A', userId: U },
                { teamId: 'team-A', userId: TEAMMATE_A },
              ]
            : args.where.teamId.in.includes('team-B')
              ? [
                  { teamId: 'team-B', userId: U },
                  { teamId: 'team-B', userId: TEAMMATE_B },
                ]
              : [],
        ),
      },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma };
  }

  it('teamUserIds(U, company B) only contains U + B teammates — never A teammates', async () => {
    const { service } = makeService();
    const inB = await service.teamUserIds(U, COMPANY_B);
    expect(inB).toEqual(expect.arrayContaining([U, TEAMMATE_B]));
    expect(inB).not.toContain(TEAMMATE_A);

    const inA = await service.teamUserIds(U, COMPANY_A);
    expect(inA).toEqual(expect.arrayContaining([U, TEAMMATE_A]));
    expect(inA).not.toContain(TEAMMATE_B);
  });

  it('a company-B team query is pinned to companyId = B', async () => {
    const { service, prisma } = makeService();
    await service.teamUserIds(U, COMPANY_B);
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: COMPANY_B }),
      }),
    );
  });

  it('TEAM-scope list in company B never widens to A teammates', async () => {
    const { service, prisma } = makeService();
    await service.list(COMPANY_B, { userId: U, scope: 'TEAM' }, {} as never);
    const where = (prisma.party.findMany as jest.Mock).mock.calls[0][0].where;
    const owners = (where.ownerUserId as { in: string[] }).in;
    expect(owners).toContain(TEAMMATE_B);
    expect(owners).not.toContain(TEAMMATE_A);
  });

  it('the team manager contributes members even without membership (managerId path)', async () => {
    const prisma = {
      team: {
        findMany: jest.fn(async () => [{ id: 'team-A' }]),
      },
      teamMember: {
        findMany: jest.fn(async (args: { where: { teamId: { in: string[] } } }) =>
          args.where.teamId.in.includes('team-A')
            ? [
                { teamId: 'team-A', userId: TEAMMATE_A },
                { teamId: 'team-A', userId: 'user-member' },
              ]
            : [],
        ),
      },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    // U manages team-A but is not in team_members — still resolves the team.
    const ids = await service.teamUserIds(U, COMPANY_A);
    expect(ids).toEqual(expect.arrayContaining([TEAMMATE_A, 'user-member']));
    expect(prisma.team.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ members: { some: { userId: U } } }, { managerId: U }],
        }),
      }),
    );
  });

  describeIntegration('corr-04 integration (live DB)', () => {
    const prisma = integrationPrisma();
    const COMPANY_B = testUuid();
    const marker = Date.now();
    let userId: string;
    let teammateAId: string;
    let teammateBId: string;
    let teamAId: string;
    let teamBId: string;
    let partyOfTeammateA: string;
    let partyOfTeammateB: string;

    beforeAll(async () => {
      await prisma.company.create({ data: { id: COMPANY_B, nameFa: `شرکت بی کُر۴ ${marker}` } });
      const mk = (n: string) =>
        prisma.user.create({
          data: { username: `${n}-${marker}`, passwordHash: 'x' },
          select: { id: true },
        });
      [userId, teammateAId, teammateBId] = (await Promise.all([mk('u4'), mk('ta4'), mk('tb4')])).map(
        (r) => r.id,
      );

      const teamA = await prisma.team.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID, // company A
          name: `تیم الف کُر۴ ${marker}`,
          members: { create: [{ userId }, { userId: teammateAId }] },
        },
      });
      teamAId = teamA.id;
      const teamB = await prisma.team.create({
        data: {
          companyId: COMPANY_B, // company B
          name: `تیم بی کُر۴ ${marker}`,
          members: { create: [{ userId }, { userId: teammateBId }] },
        },
      });
      teamBId = teamB.id;

      const pa = await prisma.party.create({
        data: {
          companyId: COMPANY_B,
          type: 'COMPANY',
          nameFa: `شرکت هم‌تیمی الف کُر۴ ${marker}`,
          ownerUserId: teammateAId, // A teammate owning a party IN company B
        },
      });
      partyOfTeammateA = pa.id;
      const pb = await prisma.party.create({
        data: {
          companyId: COMPANY_B,
          type: 'COMPANY',
          nameFa: `شرکت هم‌تیمی بی کُر۴ ${marker}`,
          ownerUserId: teammateBId,
        },
      });
      partyOfTeammateB = pb.id;
    });

    it('TEAM scope inside company B sees B teammates but NOT the A-teammate who owns a B party', async () => {
      const service = new PartiesService(
        prisma as never,
        { record: jest.fn(), recordTx: jest.fn() } as never,
        new TimelineService(prisma as never),
      );
      const result = await service.list(
        COMPANY_B,
        { userId, scope: 'TEAM' },
        { page: 1, pageSize: 100, sortDir: 'desc' } as never,
      );
      const ids = result.items.map((i) => i.id);
      expect(ids).toContain(partyOfTeammateB);
      expect(ids).not.toContain(partyOfTeammateA);
      // …and vice versa: inside company A, the B teammate is invisible.
      const inA = await service.teamUserIds(userId, INTEGRATION_COMPANY_ID);
      expect(inA).not.toContain(teammateBId);
      expect(inA).toEqual(expect.arrayContaining([userId, teammateAId]));
    });

    afterAll(async () => {
      const partyIds = [partyOfTeammateA, partyOfTeammateB].filter(Boolean);
      await prisma.party.deleteMany({ where: { id: { in: partyIds } } });
      await prisma.teamMember.deleteMany({ where: { teamId: { in: [teamAId, teamBId] } } });
      await prisma.team.deleteMany({ where: { id: { in: [teamAId, teamBId] } } });
      await prisma.user.deleteMany({ where: { id: { in: [userId, teammateAId, teammateBId] } } });
      await prisma.company.deleteMany({ where: { id: COMPANY_B } });
      await disconnectIntegrationPrisma();
    });
  });
});
