import { Prisma } from '@prisma/client';
import { normalizeIranMobile } from '../common/utils/phone';
import { normalizePersianName } from '../common/utils/persian-name';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  testUuid,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * p3a-01 — duplicate-normalized-phone: an exact duplicate normalized MOBILE
 * inside a company is blocked with ConflictError `DUPLICATE_PHONE`, no matter
 * how the number was written (Persian digits, +98/0098/98 prefixes,
 * separators). The DB partial unique `parties_mobile_uniq` is the backstop.
 */
describe('p3a-01 duplicate-normalized-phone', () => {
  const COMPANY = 'company-1';

  function makeService(existingPhoneRow: Record<string, unknown> | null) {
    // Lazy import so jest.resetModules-based variants stay simple.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PartiesService } = require('./parties.service') as typeof import('./parties.service');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { TimelineService } = require('./timeline.service') as typeof import('./timeline.service');

    const createdParties: Record<string, unknown>[] = [];
    const findFirstQueries: Record<string, unknown>[] = [];
    const trx = {
      party: {
        create: jest.fn(async (args: { data: object }) => {
          createdParties.push(args.data as Record<string, unknown>);
          return { id: 'party-new', ...args.data };
        }),
      },
      timelineEvent: { create: jest.fn(async (args: unknown) => args) },
    };
    const prisma = {
      partyPhone: {
        findFirst: jest.fn(async (args: Record<string, unknown>) => {
          findFirstQueries.push(args);
          return existingPhoneRow;
        }),
      },
      $queryRaw: jest.fn(async () => []), // no similar-name rows
      user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn() };
    const timeline = new TimelineService(prisma as never);
    const service = new PartiesService(prisma as never, audit as never, timeline);
    return { service, prisma, trx, createdParties, findFirstQueries, audit };
  }

  const existingRow = {
    partyId: 'party-existing',
    normalizedValue: '09121234567',
  };

  it.each([
    ['plain', '09121234567'],
    ['+98 prefix', '+989121234567'],
    ['0098 prefix', '00989121234567'],
    ['9 prefix', '9121234567'],
    ['persian digits', '۰۹۱۲۱۲۳۴۵۶۷'],
    ['arabic digits', '٠٩١٢١٢٣٤٥٦٧'],
    ['separated', '+98 912 123 4567'],
  ])('blocks creation when the mobile (%s) normalizes to an existing number', async (_label, mobile) => {
    expect(normalizeIranMobile(mobile)).toBe('09121234567');
    const { service, findFirstQueries } = makeService(existingRow);

    await expect(
      service.create(
        COMPANY,
        { type: 'PERSON', nameFa: 'محمدرضا کریمی', phones: [{ kind: 'MOBILE', value: mobile }] },
        { id: 'u1', username: 'sales' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'DUPLICATE_PHONE', details: { partyId: 'party-existing' } });

    // The duplicate probe must have run against the CANONICAL number.
    const where = (findFirstQueries[0] as { where: Record<string, unknown> }).where;
    expect(where).toMatchObject({
      companyId: COMPANY,
      kind: 'MOBILE',
      normalizedValue: { in: ['09121234567'] },
    });
  });

  it('creates normally when no duplicate exists', async () => {
    const { service, createdParties, audit } = makeService(null);
    const result = await service.create(
      COMPANY,
      {
        type: 'PERSON',
        nameFa: 'محمدرضا کریمی',
        phones: [{ kind: 'MOBILE', value: '+98 912 123 4567' }],
      },
      { id: 'u1', username: 'sales' },
      {},
    );
    expect(createdParties[0]).toMatchObject({ nameFa: 'محمدرضا کریمی' });
    expect(result.warnings).toEqual([]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: 'party', action: 'CREATE' }),
    );
  });

  it('maps a racing unique violation on parties_mobile_uniq to DUPLICATE_PHONE', async () => {
    const { PartiesService } = require('./parties.service') as typeof import('./parties.service');
    const { TimelineService } = require('./timeline.service') as typeof import('./timeline.service');

    const prismaError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: 'test' },
    );
    prismaError.meta = { target: ['parties_mobile_uniq'] };

    const trx = {
      party: { create: jest.fn(async () => { throw prismaError; }) },
      timelineEvent: { create: jest.fn() },
    };
    const prisma = {
      partyPhone: { findFirst: jest.fn(async () => null) },
      $queryRaw: jest.fn(async () => []),
      user: { findUnique: jest.fn(async () => ({ id: 'u1' })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    await expect(
      service.create(
        COMPANY,
        { type: 'PERSON', nameFa: 'محمدرضا کریمی', phones: [{ kind: 'MOBILE', value: '09121234567' }] },
        { id: 'u1', username: 'sales' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'DUPLICATE_PHONE' });
  });

  it('normalizes names before similarity (shared util sanity)', () => {
    // Arabic Kaf (ك) → Persian Kaf (ک) and whitespace runs collapse, so both
    // spellings feed pg_trgm with one canonical form.
    expect(normalizePersianName('محمدمی    كارمندی ')).toBe('محمدمی کارمندی');
    expect(normalizePersianName('كارمندی')).toBe(normalizePersianName('کارمندی'));
  });

  describeIntegration('p3a-01 integration (live DB)', () => {
    it('a second party with the same normalized mobile violates the partial unique parties_mobile_uniq', async () => {
      const prisma = integrationPrisma();
      const company = INTEGRATION_COMPANY_ID;
      const mobile = `0912${String(Date.now()).slice(-7)}`;
      const nameA = `تست پ۳ا الف ${Date.now()}`;
      const nameB = `تست پ۳ا ب ${Date.now()}`;

      const first = await prisma.party.create({
        data: {
          companyId: company,
          type: 'PERSON',
          nameFa: nameA,
          phones: {
            create: { companyId: company, kind: 'MOBILE', rawValue: mobile, normalizedValue: mobile },
          },
        },
      });

      // Different raw spellings, same normalized value → the DB must reject.
      await expect(
        prisma.party.create({
          data: {
            companyId: company,
            type: 'PERSON',
            nameFa: nameB,
            phones: {
              create: {
                companyId: company,
                kind: 'MOBILE',
                rawValue: `+98 ${mobile.slice(1)}`,
                normalizedValue: normalizeIranMobile(`+98 ${mobile.slice(1)}`),
              },
            },
          },
        }),
      ).rejects.toThrow();

      await prisma.party.delete({ where: { id: first.id } });
      await disconnectIntegrationPrisma();
    }, 20_000);
  });
});
