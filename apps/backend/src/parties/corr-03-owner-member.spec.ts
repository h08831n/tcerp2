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
 * corr-03 — owner must be a company member: on party create (ownerUserId in
 * body), PATCH (ownerUserId change) and POST /:id/owner, the target user must
 * be an ACTIVE member of the party's company (user_companies ⋈
 * users.status = 'ACTIVE'). A globally existing but non-member user is NEVER
 * accepted → ValidationError 'OWNER_NOT_COMPANY_MEMBER'.
 */
describe('corr-03 owner-must-be-company-member', () => {
  const COMPANY_A = 'company-A';
  const OWNER = 'user-owner';
  const ALI = 'user-ali';

  function makeService(partyRow: Record<string, unknown> | null, aliIsMember = false) {
    const trx = {
      party: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async () => ({})),
      },
      timelineEvent: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      party: { findUnique: jest.fn(async () => partyRow) },
      team: { findMany: jest.fn(async () => []) },
      teamMember: { findMany: jest.fn(async () => []) },
      $queryRaw: jest.fn(async () => []), // no similar-name rows
      // Ali is a member of company B only — the probe for company A fails.
      userCompany: {
        findFirst: jest.fn(async (args: { where: { userId: string; companyId: string } }) =>
          args.where.companyId === COMPANY_A && aliIsMember ? { userId: args.where.userId } : null,
        ),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma, trx };
  }

  const party = {
    id: 'party-1',
    companyId: COMPANY_A,
    ownerUserId: OWNER,
    version: 2,
    nameFa: 'شرکت الف',
  };
  const actor = { id: OWNER, username: 'owner' };

  it('create: a non-member ownerUserId is rejected with OWNER_NOT_COMPANY_MEMBER', async () => {
    const { service, prisma } = makeService(null);
    await expect(
      service.create(
        COMPANY_A,
        { type: 'COMPANY', nameFa: 'شرکت جدید', ownerUserId: 'not-a-user' } as never,
        actor,
        {},
      ),
    ).rejects.toMatchObject({ message: 'OWNER_NOT_COMPANY_MEMBER' });
    expect(prisma.userCompany.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyId: COMPANY_A, userId: 'not-a-user' }),
      }),
    );
  });

  it('PATCH: changing the owner to a non-member fails BEFORE any mutation', async () => {
    const { service, trx } = makeService(party);
    await expect(
      service.update(
        COMPANY_A,
        { userId: OWNER, scope: 'ALL' },
        'party-1',
        { version: 2, ownerUserId: 'user-ali' } as never,
        { canChangeOwner: true },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ message: 'OWNER_NOT_COMPANY_MEMBER' });
    expect(trx.party.updateMany).not.toHaveBeenCalled();
  });

  it('POST /:id/owner: non-member fails; after adding the membership it succeeds', async () => {
    const failing = makeService(party);
    await expect(
      failing.service.changeOwner(
        COMPANY_A,
        { userId: OWNER, scope: 'ALL' },
        'party-1',
        { userId: ALI },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ message: 'OWNER_NOT_COMPANY_MEMBER' });
    expect(failing.trx.party.updateMany).not.toHaveBeenCalled();

    const succeeding = makeService(party, true);
    await succeeding.service.changeOwner(
      COMPANY_A,
      { userId: OWNER, scope: 'ALL' },
      'party-1',
      { userId: ALI },
      actor,
      {},
    );
    expect(succeeding.trx.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'party-1', version: 2 },
        data: expect.objectContaining({ ownerUserId: ALI, version: 3 }),
      }),
    );
  });

  describeIntegration('corr-03 integration (live DB)', () => {
    const prisma = integrationPrisma();
    const COMPANY_B = testUuid();
    const marker = Date.now();
    let aliId: string;
    let adminId: string;
    let partyId: string;

    beforeAll(async () => {
      await prisma.company.create({
        data: { id: COMPANY_B, nameFa: `شرکت بی کُر۳ ${marker}` },
      });
      const ali = await prisma.user.create({
        data: {
          username: `ali-corr03-${marker}`,
          passwordHash: 'x',
          status: 'ACTIVE',
          companies: { create: { companyId: COMPANY_B } }, // member of B ONLY
        },
      });
      aliId = ali.id;
      const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
      adminId = admin.id;

      const party = await prisma.party.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID, // company A
          type: 'COMPANY',
          nameFa: `شرکت مالکیت کُر۳ ${marker}`,
          ownerUserId: adminId,
        },
      });
      partyId = party.id;
    });

    it('assigning Ali (member of company B only) as owner fails with the controlled error', async () => {
      const service = new PartiesService(
        prisma as never,
        { record: jest.fn(), recordTx: jest.fn() } as never,
        new TimelineService(prisma as never),
      );
      await expect(
        service.changeOwner(
          INTEGRATION_COMPANY_ID,
          { userId: adminId, scope: 'ALL' },
          partyId,
          { userId: aliId },
          { id: adminId, username: 'admin' },
          {},
        ),
      ).rejects.toMatchObject({ message: 'OWNER_NOT_COMPANY_MEMBER' });

      // Nothing changed: still owned by admin, version untouched.
      const party = await prisma.party.findUniqueOrThrow({ where: { id: partyId } });
      expect(party.ownerUserId).toBe(adminId);
    });

    it('after adding the company-A membership the assignment succeeds', async () => {
      await prisma.userCompany.create({ data: { userId: aliId, companyId: INTEGRATION_COMPANY_ID } });

      const service = new PartiesService(
        prisma as never,
        { record: jest.fn(), recordTx: jest.fn() } as never,
        new TimelineService(prisma as never),
      );
      await service.changeOwner(
        INTEGRATION_COMPANY_ID,
        { userId: adminId, scope: 'ALL' },
        partyId,
        { userId: aliId },
        { id: adminId, username: 'admin' },
        {},
      );
      const party = await prisma.party.findUniqueOrThrow({ where: { id: partyId } });
      expect(party.ownerUserId).toBe(aliId);
    });

    afterAll(async () => {
      await prisma.timelineEvent.deleteMany({ where: { entityType: 'PARTY', entityId: partyId } });
      await prisma.party.deleteMany({ where: { id: partyId } }).catch(() => undefined);
      await prisma.userCompany.deleteMany({ where: { userId: aliId } });
      await prisma.user.deleteMany({ where: { id: aliId } });
      await prisma.company.deleteMany({ where: { id: COMPANY_B } });
      await disconnectIntegrationPrisma();
    });
  });
});
