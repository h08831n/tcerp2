import { FinancialResponsibilityService } from './financial-responsibility.service';
import { TimelineService } from './timeline.service';

/**
 * p3a-09 — financial-responsibility-aggregation: Ravan is the responsible
 * party, Alpha and Beta are members; a member belongs to exactly one group
 * per company; the consolidated balance joins party_operational_balances and
 * sums the responsible party + all members.
 */
describe('p3a-09 financial-responsibility-aggregation', () => {
  const COMPANY = 'company-1';
  const RAVAN = 'party-ravan';
  const ALPHA = 'party-alpha';
  const BETA = 'party-beta';

  function makeService() {
    // memberPartyId -> responsiblePartyId
    const memberships: Record<string, string> = {};
    const balances: Record<string, string> = { [RAVAN]: '1000', [ALPHA]: '250' };

    const prisma = {
      party: {
        findFirst: jest.fn(
          async (args: { where: { id: string; companyId: string } }) =>
            args.where.companyId === COMPANY
              ? { id: args.where.id, nameFa: `نام ${args.where.id}`, archivedAt: null }
              : null,
        ),
        findUnique: jest.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          nameFa: `نام ${args.where.id}`,
          score: null,
        })),
      },
      financialResponsibility: {
        findUnique: jest.fn(
          async (args: {
            where: { companyId_memberPartyId: { companyId: string; memberPartyId: string } };
          }) => {
            const member = args.where.companyId_memberPartyId.memberPartyId;
            const responsible = memberships[member];
            return responsible ? { id: `fr-${member}`, responsiblePartyId: responsible } : null;
          },
        ),
        findFirst: jest.fn(
          async (args: { where: { companyId: string; responsiblePartyId: string } }) =>
            Object.values(memberships).includes(args.where.responsiblePartyId)
              ? { responsiblePartyId: args.where.responsiblePartyId }
              : null,
        ),
        findMany: jest.fn(
          async (args: { where: { companyId: string; responsiblePartyId: string } }) =>
            Object.entries(memberships)
              .filter(([, responsible]) => responsible === args.where.responsiblePartyId)
              .map(([member]) => ({
                memberParty: { id: member, nameFa: `نام ${member}`, score: null },
              })),
        ),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const d = args.data as {
            companyId: string;
            responsiblePartyId: string;
            memberPartyId: string;
          };
          memberships[d.memberPartyId] = d.responsiblePartyId;
          return { id: 'fr-1', ...d };
        }),
        delete: jest.fn(async (args: { where: { id: string } }) => {
          // id is `fr-<memberPartyId>` (see findUnique above) — mimic the DB
          // cascade by dropping the membership from the store.
          const member = args.where.id.replace(/^fr-/, '');
          delete memberships[member];
          return {};
        }),
      },
      partyOperationalBalance: {
        findMany: jest.fn(
          async (args: { where: { companyId: string; partyId: { in: string[] } } }) =>
            args.where.partyId.in
              .filter((id) => balances[id] !== undefined)
              .map((id) => ({ partyId: id, balance: balances[id] })),
        ),
      },
      timelineEvent: { create: jest.fn(async (args: unknown) => args) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn({})),
    };

    const timeline = new TimelineService(prisma as never);
    const audit = { record: jest.fn() };
    const service = new FinancialResponsibilityService(prisma as never, audit as never, timeline);
    return { service, memberships };
  }

  const actor = { id: 'u1', username: 'clerk' };

  it('rejects self-group (a party cannot be responsible for itself)', async () => {
    const { service } = makeService();
    await expect(
      service.addMember(COMPANY, RAVAN, { responsiblePartyId: RAVAN }, actor, {}),
    ).rejects.toMatchObject({ message: 'SELF_RESPONSIBILITY' });
  });

  it('adds Alpha and Beta to Ravan’s group; a member of another group is rejected', async () => {
    const { service } = makeService();
    await service.addMember(COMPANY, ALPHA, { responsiblePartyId: RAVAN }, actor, {});
    await service.addMember(COMPANY, BETA, { responsiblePartyId: RAVAN }, actor, {});

    await expect(
      service.addMember(COMPANY, ALPHA, { responsiblePartyId: RAVAN }, actor, {}),
    ).rejects.toMatchObject({ message: 'ALREADY_MEMBER' });
    await expect(
      service.addMember(COMPANY, ALPHA, { responsiblePartyId: 'party-other' }, actor, {}),
    ).rejects.toMatchObject({
      message: 'ALREADY_IN_GROUP',
      details: { currentResponsiblePartyId: RAVAN },
    });
  });

  it('aggregates consolidated balance = responsible + members, joined from party_operational_balances', async () => {
    const { service } = makeService();
    await service.addMember(COMPANY, ALPHA, { responsiblePartyId: RAVAN }, actor, {});
    await service.addMember(COMPANY, BETA, { responsiblePartyId: RAVAN }, actor, {});

    const view = await service.getGroup(COMPANY, ALPHA); // asked from a member’s perspective
    expect(view.group).toEqual({ responsiblePartyId: RAVAN, nameFa: `نام ${RAVAN}` });
    expect(view.members.map((m) => m.partyId).sort()).toEqual([ALPHA, BETA, RAVAN].sort());
    expect(view.members.find((m) => m.partyId === RAVAN)?.isResponsible).toBe(true);
    expect(view.members.find((m) => m.partyId === ALPHA)?.balance).toBe(250);
    expect(view.consolidatedAvailable).toBe(true);
    expect(view.consolidatedBalance).toBe(1000 + 250);
  });

  it('a member without a balance row reports null and contributes 0', async () => {
    const { service } = makeService();
    await service.addMember(COMPANY, ALPHA, { responsiblePartyId: RAVAN }, actor, {});
    await service.addMember(COMPANY, BETA, { responsiblePartyId: RAVAN }, actor, {});

    const view = await service.getGroup(COMPANY, RAVAN);
    expect(view.members.find((m) => m.partyId === BETA)?.balance).toBeNull();
    expect(view.consolidatedBalance).toBe(1000 + 250);
  });

  it('removeMembership deletes the link; a non-member gets NotFoundError', async () => {
    const { service } = makeService();
    await service.addMember(COMPANY, ALPHA, { responsiblePartyId: RAVAN }, actor, {});
    await expect(
      service.removeMembership(COMPANY, ALPHA, actor, {}),
    ).resolves.toMatchObject({ removed: true, memberPartyId: ALPHA });
    await expect(service.removeMembership(COMPANY, ALPHA, actor, {})).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
