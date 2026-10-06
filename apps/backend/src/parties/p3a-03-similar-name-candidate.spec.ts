import { Prisma } from '@prisma/client';
import { PartiesService } from './parties.service';
import { TimelineService } from './timeline.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * p3a-03 — similar-name-candidate: a pg_trgm similarity >= 0.85 hit shows up
 * as a WARNING in the create result (and the creation proceeds); below the
 * threshold there is no warning. Similar names NEVER block creation.
 */
describe('p3a-03 similar-name-candidate', () => {
  const COMPANY = 'company-1';

  function makeService(queryRawRows: Array<{ id: string; name_fa: string; similarity: number }>) {
    const createdParties: Record<string, unknown>[] = [];
    let query: Prisma.Sql | undefined;
    const trx = {
      party: {
        create: jest.fn(async (args: { data: object }) => {
          createdParties.push(args.data as Record<string, unknown>);
          return { id: 'party-new', ...args.data };
        }),
      },
      timelineEvent: { create: jest.fn(async () => ({})) },
    };
    const prisma = {
      partyPhone: { findFirst: jest.fn(async () => null) },
      $queryRaw: jest.fn(async (q: Prisma.Sql) => {
        query = q;
        return queryRawRows;
      }),
      // corr-03: the default owner (the creating actor) is a company member.
      userCompany: { findFirst: jest.fn(async () => ({ userId: 'u1' })) },
      user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const timeline = new TimelineService(prisma as never);
    const service = new PartiesService(prisma as never, audit as never, timeline);
    return { service, prisma, createdParties, get query() { return query; } };
  }

  it('returns a similar-name warning at similarity >= 0.85 and still creates the party', async () => {
    const { service, createdParties } = makeService([
      { id: 'party-other', name_fa: 'آریا فولاد سپاهان', similarity: 0.91 },
    ]);

    const result = await service.create(
      COMPANY,
      { type: 'COMPANY', nameFa: 'اریا فولاد سپاهان' }, // Arabic Yeh variant
      { id: 'u1', username: 'sales' },
      {},
    );

    expect(createdParties).toHaveLength(1); // creation proceeded
    expect(result.warnings).toEqual([
      { partyId: 'party-other', nameFa: 'آریا فولاد سپاهان', similarity: 0.91 },
    ]);
  });

  it('returns no warning when nothing is similar', async () => {
    const { service } = makeService([]);
    const result = await service.create(
      COMPANY,
      { type: 'COMPANY', nameFa: 'بازرگانی پارس فن آوران' },
      { id: 'u1', username: 'sales' },
      {},
    );
    expect(result.warnings).toEqual([]);
  });

  it('queries with parameter binding, 0.85 threshold, excluding archived rows', async () => {
    const { service, prisma } = makeService([]);
    await service.findSimilarNames(COMPANY, 'آریا فولاد');

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('similarity(name_fa');
    expect(sql.text).toContain('>= $'); // threshold is bound, not interpolated
    expect(sql.text).toContain('archived_at IS NULL');
    // The name is bound as a parameter, never spliced into the SQL text.
    expect(sql.values).toContain('آریا فولاد');
    expect(sql.values).toContain(0.85);
  });

  it('excludes the party itself when excludePartyId is given', async () => {
    const { service, prisma } = makeService([]);
    await service.findSimilarNames(COMPANY, 'آریا فولاد', 'party-self');
    const sql = (prisma.$queryRaw as jest.Mock).mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('id <>');
    expect(sql.values).toContain('party-self');
  });

  describeIntegration('p3a-03 integration (live DB, pg_trgm)', () => {
    it('similarity() >= 0.85 finds the stored party for an identically-normalized name; dissimilar names do not match', async () => {
      const prisma = integrationPrisma();
      const company = INTEGRATION_COMPANY_ID;
      const marker = Date.now();
      const nameFa = `شرکت آزمایشی یکتا پ۳ا ${marker}`;

      const party = await prisma.party.create({
        data: { companyId: company, type: 'COMPANY', nameFa },
      });

      const service = new PartiesService(
        prisma as never,
        { record: jest.fn() } as never,
        new TimelineService(prisma as never),
      );
      try {
        // Same name (whitespace variant) → similarity 1.0 ≥ 0.85.
        const hits = await service.findSimilarNames(company, `شرکت آزمایشی یکتا پ۳ا   ${marker}`);
        expect(hits.map((h) => h.partyId)).toContain(party.id);
        expect(hits[0].similarity).toBeGreaterThanOrEqual(0.85);

        // A dissimilar name stays below the threshold.
        const none = await service.findSimilarNames(company, `نام کاملا متفاوت ${marker}`);
        expect(none).toHaveLength(0);
      } finally {
        await prisma.party.delete({ where: { id: party.id } });
        await disconnectIntegrationPrisma();
      }
    }, 20_000);
  });
});
