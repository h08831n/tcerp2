import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';

/**
 * p3a-08 — owner-reassignment-audit: changing a party’s owner writes BOTH a
 * dedicated OWNER_CHANGED audit entry and an OWNER_CHANGED timeline event,
 * bumps the optimistic version, and is permission-gated.
 */
describe('p3a-08 owner-reassignment-audit', () => {
  const COMPANY = 'company-1';
  const OLD_OWNER = 'user-old';
  const NEW_OWNER = 'user-new';

  function makeService(partyRow: Record<string, unknown>) {
    const timelineEvents: Record<string, unknown>[] = [];
    const trx = {
      party: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        update: jest.fn(async () => ({})),
      },
      timelineEvent: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          timelineEvents.push(args.data as Record<string, unknown>);
          return args.data;
        }),
      },
    };
    const prisma = {
      party: { findUnique: jest.fn(async () => partyRow) },
      teamMember: { findMany: jest.fn(async () => []) },
      user: { findUnique: jest.fn(async (args: { where: { id: string } }) => ({ id: args.where.id })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn() };
    const service = new PartiesService(
      prisma as never,
      audit as never,
      new TimelineService(prisma as never),
    );
    return { service, audit, timelineEvents, trx };
  }

  const party = {
    id: 'party-1',
    companyId: COMPANY,
    ownerUserId: OLD_OWNER,
    version: 4,
    nameFa: 'شرکت رعنا',
  };

  it('changeOwner writes audit OWNER_CHANGED + timeline OWNER_CHANGED and bumps version', async () => {
    const { service, audit, timelineEvents, trx } = makeService(party);

    await service.changeOwner(
      COMPANY,
      { userId: OLD_OWNER, scope: 'ALL' },
      'party-1',
      { userId: NEW_OWNER },
      { id: 'admin', username: 'admin' },
      {},
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'party',
        entityId: 'party-1',
        action: 'OWNER_CHANGED',
        oldValues: { ownerUserId: OLD_OWNER },
        newValues: { ownerUserId: NEW_OWNER },
      }),
    );
    const ownerEvent = timelineEvents.find((e) => e.type === 'OWNER_CHANGED');
    expect(ownerEvent).toMatchObject({
      entityType: 'PARTY',
      entityId: 'party-1',
      data: { oldOwnerUserId: OLD_OWNER, newOwnerUserId: NEW_OWNER },
    });
    expect(trx.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'party-1', version: 4 },
        data: expect.objectContaining({ ownerUserId: NEW_OWNER, version: 5 }),
      }),
    );
  });

  it('PATCH with ownerUserId without parties.owner.change → ForbiddenError', async () => {
    const { service, audit } = makeService(party);
    await expect(
      service.update(
        COMPANY,
        { userId: OLD_OWNER, scope: 'OWN' },
        'party-1',
        { version: 4, ownerUserId: NEW_OWNER },
        { canChangeOwner: false },
        { id: OLD_OWNER, username: 'sales' },
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('PATCH with ownerUserId and the permission changes the owner (via update)', async () => {
    const { service, audit, timelineEvents } = makeService(party);
    await service.update(
      COMPANY,
      { userId: OLD_OWNER, scope: 'ALL' },
      'party-1',
      { version: 4, ownerUserId: NEW_OWNER },
      { canChangeOwner: true },
      { id: 'mgr', username: 'mgr' },
      {},
    );
    const ownerAudit = audit.record.mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .find((a) => a.action === 'OWNER_CHANGED');
    expect(ownerAudit).toMatchObject({
      entityType: 'party',
      entityId: 'party-1',
    });
    expect(timelineEvents.some((e) => e.type === 'OWNER_CHANGED')).toBe(true);
  });
});
