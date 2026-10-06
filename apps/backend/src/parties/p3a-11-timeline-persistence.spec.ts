import { TimelineService } from './timeline.service';

/**
 * p3a-11 — timeline-persistence: TimelineEvent rows are append-only and read
 * back newest-first; hidden rows (visible=false, e.g. routine score
 * recomputes) are excluded unless includeHidden is granted, and the limit is
 * clamped to a sane range.
 */
describe('p3a-11 timeline-persistence', () => {
  const COMPANY = 'company-1';

  function makeTimeline() {
    const rows: Record<string, unknown>[] = [];
    const prisma = {
      timelineEvent: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `evt-${rows.length + 1}`, ...args.data };
          rows.push(row);
          return row;
        }),
        findMany: jest.fn(
          async (args: {
            where: Record<string, unknown>;
            orderBy: { createdAt: string };
            take: number;
          }) => {
            // Newest first, mirroring orderBy createdAt desc.
            return [...rows]
              .reverse()
              .filter((r) => {
                const w = args.where as {
                  companyId: string;
                  entityType: string;
                  entityId: string;
                  visible?: boolean;
                };
                if (r.companyId !== w.companyId) return false;
                if (r.entityId !== w.entityId) return false;
                if (w.visible === true && r.visible !== true) return false;
                return true;
              })
              .slice(0, args.take);
          },
        ),
      },
    };
    const timeline = new TimelineService(prisma as never);
    return { timeline, rows, prisma };
  }

  it('records events company-scoped with actor and data, visible by default', async () => {
    const { timeline, rows } = makeTimeline();
    await timeline.record(null as never, {
      companyId: COMPANY,
      entityType: 'PARTY',
      entityId: 'party-1',
      type: 'ROLE_ADDED',
      title: 'افزودن نقش',
      data: { role: 'CUSTOMER' },
      actorUserId: 'u1',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      companyId: COMPANY,
      entityType: 'PARTY',
      entityId: 'party-1',
      type: 'ROLE_ADDED',
      actorType: 'USER',
      actorUserId: 'u1',
      visible: true,
    });
  });

  it('explicit visible:false persists (noise control)', async () => {
    const { timeline, rows } = makeTimeline();
    await timeline.record(null as never, {
      companyId: COMPANY,
      entityType: 'PARTY',
      entityId: 'party-1',
      type: 'SCORE_RECOMPUTED',
      title: 'بازمحاسبه امتیاز',
      visible: false,
    });
    expect(rows[0]).toMatchObject({ visible: false });
  });

  it('reads back newest-first for the entity', async () => {
    const { timeline } = makeTimeline();
    for (const type of ['PARTY_CREATED', 'ROLE_ADDED', 'PHONE_ADDED']) {
      await timeline.record(null as never, {
        companyId: COMPANY,
        entityType: 'PARTY',
        entityId: 'party-1',
        type,
        title: type,
      });
    }
    const events = await timeline.listForEntity(COMPANY, 'PARTY', 'party-1');
    expect(events.map((e) => e.type)).toEqual(['PHONE_ADDED', 'ROLE_ADDED', 'PARTY_CREATED']);
  });

  it('hides visible=false rows unless includeHidden is requested', async () => {
    const { timeline } = makeTimeline();
    await timeline.record(null as never, {
      companyId: COMPANY,
      entityType: 'PARTY',
      entityId: 'party-1',
      type: 'PARTY_CREATED',
      title: 'ایجاد',
    });
    await timeline.record(null as never, {
      companyId: COMPANY,
      entityType: 'PARTY',
      entityId: 'party-1',
      type: 'SCORE_RECOMPUTED',
      title: 'بازمحاسبه',
      visible: false,
    });

    const visible = await timeline.listForEntity(COMPANY, 'PARTY', 'party-1');
    expect(visible.map((e) => e.type)).toEqual(['PARTY_CREATED']);

    const everything = await timeline.listForEntity(COMPANY, 'PARTY', 'party-1', {
      includeHidden: true,
    });
    expect(everything).toHaveLength(2);
  });

  it('only queries the requested entity and clamps limit to [1, 200]', async () => {
    const { timeline, prisma } = makeTimeline();
    await timeline.listForEntity(COMPANY, 'PARTY', 'party-1', { limit: 5 });
    let call = (prisma.timelineEvent.findMany as jest.Mock).mock.calls[0][0];
    expect(call.where).toMatchObject({ companyId: COMPANY, entityId: 'party-1', visible: true });
    expect(call.take).toBe(5);

    await timeline.listForEntity(COMPANY, 'PARTY', 'party-1', { limit: 100000 });
    call = (prisma.timelineEvent.findMany as jest.Mock).mock.calls[1][0];
    expect(call.take).toBe(200);

    await timeline.listForEntity(COMPANY, 'PARTY', 'party-1', { limit: 0 });
    call = (prisma.timelineEvent.findMany as jest.Mock).mock.calls[2][0];
    expect(call.take).toBe(1);
  });
});
