import { Prisma } from '@prisma/client';
import {
  describeIntegration,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * c3b-01 — trgm-index-restored: the pg_trgm GIN index on parties.name_fa
 * (parties_name_fa_trgm_idx) exists in the live DB (it was dropped by the
 * diff-based 3B migration and restored by the p3b corrections migration),
 * and a fuzzy name search works over a seeded corpus of ~200 parties
 * (cleaned up afterwards).
 */
describeIntegration('c3b-01 trgm-index-restored (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  // The target carries the cleanup marker AND the fuzzy-search phrase, so it
  // is counted with the corpus, found by the fuzzy search, and removed by
  // afterAll together with the fillers.
  const TARGET = `شرکت کُر۳ب-${marker} هدف ${marker}`;

  beforeAll(async () => {
    // Seed 199 filler parties + 1 target (one batched insert).
    const filler = Array.from({ length: 199 }, (_, i) => ({
      companyId: INTEGRATION_COMPANY_ID,
      type: 'COMPANY' as const,
      nameFa: `شرکت کُر۳ب-${marker} شماره ${i}`,
    }));
    await prisma.party.createMany({
      data: [
        ...filler,
        { companyId: INTEGRATION_COMPANY_ID, type: 'COMPANY' as const, nameFa: TARGET },
      ],
    });
  });

  afterAll(async () => {
    await prisma.party.deleteMany({ where: { nameFa: { contains: `کُر۳ب-${marker}` } } });
    await disconnectIntegrationPrisma();
  });

  it('pg_indexes contains parties_name_fa_trgm_idx (gin, gin_trgm_ops)', async () => {
    const rows = await prisma.$queryRaw<
      Array<{ indexname: string; indexdef: string }>
    >`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'parties'`;
    const trgm = rows.find((r) => r.indexname === 'parties_name_fa_trgm_idx');
    expect(trgm).toBeDefined();
    expect(trgm!.indexdef).toContain('gin');
    expect(trgm!.indexdef).toContain('gin_trgm_ops');
    expect(trgm!.indexdef).toContain('name_fa');
  });

  it('a fuzzy search over ~200 seeded parties finds the target and respects the company', async () => {
    const total = await prisma.party.count({
      where: { companyId: INTEGRATION_COMPANY_ID, nameFa: { contains: `کُر۳ب-${marker}` } },
    });
    expect(total).toBeGreaterThanOrEqual(200);

    // Same search shape the PartiesService uses (contains, insensitive) —
    // the trgm GIN index accelerates exactly this predicate.
    const found = await prisma.party.findFirst({
      where: {
        companyId: INTEGRATION_COMPANY_ID,
        nameFa: { contains: `هدف ${marker}`, mode: 'insensitive' as const },
      },
    });
    expect(found).not.toBeNull();
    expect(found!.nameFa).toBe(TARGET);
  });

  it('EXPLAIN of the fuzzy query uses the trgm index (seq scan disabled in-session)', async () => {
    // Refresh planner statistics so the ~200 freshly-seeded rows are visible.
    await prisma.$executeRawUnsafe('ANALYZE parties');
    // With seq scans disabled the ILIKE predicate must be served by an index;
    // the trgm GIN is the only one that matches it, so the plan MUST
    // reference parties_name_fa_trgm_idx. (The company_id predicate is
    // deliberately omitted: on a ~200-row corpus a company_id btree bitmap +
    // heap scan is legitimately cheaper than the trgm lookup, which would
    // hide the proof we are after.)
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const plan = await tx.$queryRaw<Array<{ 'QUERY PLAN': string }>>(
        Prisma.sql`EXPLAIN (FORMAT TEXT) SELECT id FROM parties WHERE name_fa ILIKE ${`%${marker}%`}`,
      );
      const planText = plan.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText).toContain('parties_name_fa_trgm_idx');
    });
  });
});
