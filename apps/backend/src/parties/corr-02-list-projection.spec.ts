import { PartiesService, toPartyGridItem } from './parties.service';
import { TimelineService } from './timeline.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * corr-02 — party list projection: GET /api/parties returns EXACTLY the grid
 * fields (id, type, nameFa, nameEn, internalCode, primaryPhone, roles, owner,
 * score, scoreLevel, archived, version, createdAt, updatedAt), resolved in an
 * efficient projection — relations in the SAME findMany, at most one
 * aggregated follow-up, never N+1.
 */
describe('corr-02 list-projection', () => {
  const COMPANY = 'company-1';

  const GRID_KEYS = [
    'id',
    'type',
    'nameFa',
    'nameEn',
    'internalCode',
    'primaryPhone',
    'roles',
    'owner',
    'score',
    'scoreLevel',
    'archived',
    'version',
    'createdAt',
    'updatedAt',
  ].sort();

  function makeService(rows: Record<string, unknown>[]) {
    const calls: string[] = [];
    const prisma = {
      party: {
        findMany: jest.fn(async (args: {
          select: Record<string, unknown>;
          where: Record<string, unknown>;
        }) => {
          calls.push('party.findMany');
          // Relations MUST be selected in the same query (no N+1): phones,
          // roles and owner are part of the single select.
          expect(args.select).toMatchObject({
            phones: expect.anything(),
            roles: expect.anything(),
            owner: expect.anything(),
          });
          return rows;
        }),
        count: jest.fn(async () => {
          calls.push('party.count');
          return rows.length;
        }),
      },
      // Nothing else may be queried for the list projection.
      team: { findMany: jest.fn(async () => []) },
      teamMember: { findMany: jest.fn(async () => []) },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return { service, calls, prisma };
  }

  it('toPartyGridItem maps the row to the exact grid shape (owner name = firstName+lastName or username)', () => {
    const item = toPartyGridItem({
      id: 'p1',
      type: 'COMPANY',
      nameFa: 'شرکت الف',
      nameEn: 'Alpha Co',
      internalCode: 'IC-1',
      score: 720,
      scoreLevel: 'GOLD',
      archivedAt: null,
      version: 3,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-02T00:00:00Z'),
      owner: { id: 'u1', username: 'sales1', firstName: 'علی', lastName: 'رضایی' },
      roles: [{ role: 'CUSTOMER' }, { role: 'SUPPLIER' }],
      phones: [{ kind: 'MOBILE', normalizedValue: '09121234567' }],
    });
    expect(Object.keys(item).sort()).toEqual(GRID_KEYS);
    expect(item).toMatchObject({
      primaryPhone: { kind: 'MOBILE', normalizedValue: '09121234567' },
      roles: ['CUSTOMER', 'SUPPLIER'],
      owner: { id: 'u1', name: 'علی رضایی' },
      archived: false,
      scoreLevel: 'GOLD',
    });
  });

  it('owner without names falls back to the username; no phone → primaryPhone null; archivedAt → archived true', () => {
    const item = toPartyGridItem({
      id: 'p2',
      type: 'PERSON',
      nameFa: 'مریم کاظمی',
      nameEn: null,
      internalCode: null,
      score: null,
      scoreLevel: null,
      archivedAt: new Date('2026-02-01T00:00:00Z'),
      version: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      owner: { id: 'u2', username: 'mgr', firstName: null, lastName: null },
      roles: [],
      phones: [],
    });
    expect(item.owner).toEqual({ id: 'u2', name: 'mgr' });
    expect(item.primaryPhone).toBeNull();
    expect(item.archived).toBe(true);
  });

  it('the whole page resolves in ≤ 2 queries (findMany + count) — no N+1', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      id: `p${i}`,
      type: 'COMPANY',
      nameFa: `شرکت ${i}`,
      nameEn: null,
      internalCode: null,
      score: null,
      scoreLevel: null,
      archivedAt: null,
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      owner: { id: 'u1', username: 'u1', firstName: null, lastName: null },
      roles: [{ role: 'CUSTOMER' }],
      phones: [{ kind: 'MOBILE', normalizedValue: '0912000000' }],
    }));
    const { service, calls } = makeService(rows);
    const result = await service.list(
      COMPANY,
      { userId: 'u1', scope: 'ALL' },
      { page: 1, pageSize: 20, sortDir: 'desc' } as never,
    );
    expect(calls.filter((c) => c.startsWith('party.')).length).toBeLessThanOrEqual(2);
    expect(result.items).toHaveLength(5);
    expect(Object.keys(result.items[0]).sort()).toEqual(GRID_KEYS);
  });

  describeIntegration('corr-02 integration (live DB, 100+ parties)', () => {
    const prisma = integrationPrisma();
    const marker = Date.now();
    const COUNT = 120;
    const createdIds: string[] = [];

    it('seeds 120 parties via createMany, lists them, asserts count + exact grid shape', async () => {
      const service = new PartiesService(
        prisma as never,
        { record: jest.fn(), recordTx: jest.fn() } as never,
        new TimelineService(prisma as never),
      );

      // One party with a phone + owner to exercise the projection mapping.
      const admin = await prisma.user.findFirst({ where: { username: 'admin' } });
      const withPhone = await prisma.party.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          type: 'COMPANY',
          nameFa: `شرکت شبکه کُر دو ${marker}`,
          ownerUserId: admin?.id,
          roles: { create: { role: 'CUSTOMER' } },
          phones: {
            create: {
              companyId: INTEGRATION_COMPANY_ID,
              kind: 'MOBILE',
              rawValue: `0913${String(marker).slice(-7)}`,
              normalizedValue: `0913${String(marker).slice(-7)}`,
              isPrimary: true,
            },
          },
        },
      });
      createdIds.push(withPhone.id);

      await prisma.party.createMany({
        data: Array.from({ length: COUNT }, (_, i) => ({
          companyId: INTEGRATION_COMPANY_ID,
          type: 'PERSON' as const,
          nameFa: `شخص توده‌ای کُر۲ ${marker} #${i}`,
        })),
      });

      // Unfiltered page: total covers the bulk seed; page size caps the items.
      const unfiltered = await service.list(
        INTEGRATION_COMPANY_ID,
        { userId: admin?.id ?? 'u1', scope: 'ALL' },
        { page: 1, pageSize: 100, skip: 0, take: 100, sortDir: 'desc' } as never,
      );
      expect(unfiltered.total).toBeGreaterThanOrEqual(COUNT + 1);
      expect(unfiltered.items).toHaveLength(100);
      for (const item of unfiltered.items) {
        expect(Object.keys(item).sort()).toEqual(GRID_KEYS);
        expect(item.archived).toBe(false);
        expect(typeof item.version).toBe('number');
      }

      // Owner-filtered page: the projected party must be on it.
      const result = await service.list(
        INTEGRATION_COMPANY_ID,
        { userId: admin?.id ?? 'u1', scope: 'ALL' },
        {
          page: 1,
          pageSize: 100,
          skip: 0,
          take: 100,
          ownerUserId: admin?.id,
          sortDir: 'desc',
        } as never,
      );
      expect(result.total).toBeGreaterThanOrEqual(1);
      const projected = result.items.find((i) => i.id === withPhone.id);
      expect(projected).toMatchObject({
        primaryPhone: {
          kind: 'MOBILE',
          normalizedValue: `0913${String(marker).slice(-7)}`,
        },
        roles: ['CUSTOMER'],
        owner: { id: admin?.id },
        archived: false,
      });
      expect(projected?.owner?.name?.length ?? 0).toBeGreaterThan(0);
    }, 30_000);

    afterAll(async () => {
      if (createdIds.length) {
        await prisma.timelineEvent.deleteMany({
          where: { entityType: 'PARTY', entityId: { in: createdIds } },
        });
        await prisma.party.deleteMany({ where: { id: { in: createdIds } } });
      }
      await prisma.party.deleteMany({
        where: {
          companyId: INTEGRATION_COMPANY_ID,
          nameFa: { contains: `شخص توده‌ای کُر۲ ${marker}` },
        },
      });
      await disconnectIntegrationPrisma();
    });
  });
});
