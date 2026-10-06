import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';

/**
 * p3a-10 — archive-filtering: the default party list excludes archived rows,
 * `?archived=true` shows only archived ones, DELETE soft-archives (audit +
 * timeline + version bump) and POST /:id/restore brings the party back.
 */
describe('p3a-10 archive-filtering', () => {
  const COMPANY = 'company-1';

  function makeService(partyRow: Record<string, unknown> | null) {
    const timelineEvents: Record<string, unknown>[] = [];
    const trx = {
      party: {
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      timelineEvent: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          timelineEvents.push(args.data as Record<string, unknown>);
          return args.data;
        }),
      },
    };
    const prisma = {
      party: {
        findUnique: jest.fn(async () => partyRow),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      teamMember: { findMany: jest.fn(async () => []) },
      partyPhone: { findFirst: jest.fn(async () => null) },
      user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
      $queryRaw: jest.fn(async () => []),
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn() };
    const service = new PartiesService(
      prisma as never,
      audit as never,
      new TimelineService(prisma as never),
    );
    return { service, prisma, audit, timelineEvents, trx };
  }

  const actor = { id: 'u1', username: 'clerk' };
  const ALL = { userId: 'u1', scope: 'ALL' as const };

  it('default list excludes archived rows (archivedAt: null in the where clause)', async () => {
    const { prisma } = makeService(null);
    const svc = makeBareService(prisma);
    await svc.list(COMPANY, ALL, {} as never);
    const where = (prisma.party.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where).toMatchObject({ companyId: COMPANY, archivedAt: null });
  });

  it('?archived=true filters to archived rows only', async () => {
    const { prisma } = makeService(null);
    const svc = makeBareService(prisma);
    await svc.list(COMPANY, ALL, { archived: true } as never);
    const where = (prisma.party.findMany as jest.Mock).mock.calls[0][0].where;
    expect(where.archivedAt).toEqual({ not: null });
  });

  it('DELETE archives softly: archivedAt set, version bumped, audit + timeline written', async () => {
    const { service, audit, timelineEvents, trx } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      ownerUserId: 'u1',
      version: 2,
      archivedAt: null,
      nameFa: 'شرکت آرمان',
    });
    await service.archive(COMPANY, ALL, 'party-1', actor, {});

    expect(trx.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'party-1', version: 2 },
        data: expect.objectContaining({ version: 3, archivedBy: 'u1' }),
      }),
    );
    expect(timelineEvents.some((e) => e.type === 'PARTY_ARCHIVED')).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'party', entityId: 'party-1', action: 'ARCHIVE' }),
    );
  });

  it('archiving an already-archived party → ConflictError', async () => {
    const { service } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      ownerUserId: 'u1',
      version: 2,
      archivedAt: new Date('2026-01-01'),
      nameFa: 'شرکت آرمان',
    });
    await expect(service.archive(COMPANY, ALL, 'party-1', actor, {})).rejects.toMatchObject({
      message: 'ALREADY_ARCHIVED',
    });
  });

  it('restore clears archivedAt and writes PARTY_RESTORED timeline', async () => {
    const { service, timelineEvents, trx } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      ownerUserId: 'u1',
      version: 3,
      archivedAt: new Date('2026-01-01'),
      nameFa: 'شرکت آرمان',
    });
    await service.restore(COMPANY, ALL, 'party-1', actor, {});

    expect(trx.party.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ archivedAt: null, version: 4 }),
      }),
    );
    expect(timelineEvents.some((e) => e.type === 'PARTY_RESTORED')).toBe(true);
  });

  it('restoring a live party → ConflictError', async () => {
    const { service } = makeService({
      id: 'party-1',
      companyId: COMPANY,
      ownerUserId: 'u1',
      version: 3,
      archivedAt: null,
      nameFa: 'شرکت آرمان',
    });
    await expect(service.restore(COMPANY, ALL, 'party-1', actor, {})).rejects.toMatchObject({
      message: 'NOT_ARCHIVED',
    });
  });
});

/** Minimal PartiesService over the given prisma mock (list + scope only). */
function makeBareService(prisma: Record<string, unknown>): PartiesService {
  return new PartiesService(
    prisma as never,
    { record: jest.fn() } as never,
    new TimelineService(prisma as never),
  );
}
