import { PartiesService, phoneSearchCandidates } from './parties.service';
import { TimelineService } from './timeline.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * corr-01 — complete party search: GET /api/parties?search=… must match (with
 * company + record-scope filtering intact, OR semantics) on
 *   name_fa (ilike, trgm-indexed) · name_en · internal_code · phone
 *   (party_phones AND contact_phones normalized values) · national_id ·
 *   national_code · economic_code · registration_number.
 *
 * Matching choices (documented in PartiesService.searchWhere):
 *   - national_id / national_code → exact equals (unique identity numbers);
 *   - economic_code / registration_number / internal_code → ilike contains
 *     (code-ish fields, prefix/partial search is the useful behavior).
 */
describe('corr-01 complete-search', () => {
  const COMPANY = 'company-1';

  function makeService() {
    let lastWhere: Record<string, unknown> | undefined;
    const prisma = {
      party: {
        findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
          lastWhere = args.where;
          return [];
        }),
        count: jest.fn(async () => 0),
      },
      team: { findMany: jest.fn(async () => []) },
      teamMember: { findMany: jest.fn(async () => []) },
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
    );
    return {
      service,
      prisma,
      /** Current last captured where clause (always read fresh). */
      getWhere: () => lastWhere,
    };
  }

  function orClauses(where: Record<string, unknown> | undefined): Record<string, unknown>[] {
    return (where?.OR ?? []) as Record<string, unknown>[];
  }

  it('phoneSearchCandidates: Iranian mobile → canonical form; digit-ish → stripped digits; text → []', () => {
    expect(phoneSearchCandidates('+98 912 123 4567')).toEqual(['09121234567']);
    expect(phoneSearchCandidates('۰۹۱۲۱۲۳۴۵۶۷')).toEqual(['09121234567']);
    expect(phoneSearchCandidates('021-5566.7788')).toEqual(['02155667788']);
    expect(phoneSearchCandidates('شرکت آریا')).toEqual([]);
    expect(phoneSearchCandidates('abc12')).toEqual([]); // < 4 digits, not a phone
  });

  it('search ORs every identifier field; ids are equals, code-ish fields are ilike contains', async () => {
    const { service, getWhere } = makeService();
    await service.list(COMPANY, { userId: 'u1', scope: 'ALL' }, { search: '09121234567' } as never);

    const clauses = orClauses(getWhere());
    // identity numbers → exact equals
    expect(clauses).toContainEqual({ nationalId: '09121234567' });
    expect(clauses).toContainEqual({ nationalCode: '09121234567' });
    // code-ish fields → ilike contains
    for (const field of ['nameFa', 'nameEn', 'internalCode', 'economicCode', 'registrationNumber']) {
      expect(clauses).toContainEqual({
        [field]: { contains: '09121234567', mode: 'insensitive' },
      });
    }
    // canonical mobile → exact match on party_phones AND contact_phones
    expect(clauses).toContainEqual({
      phones: { some: { normalizedValue: '09121234567' } },
    });
    expect(clauses).toContainEqual({
      contacts: { some: { phones: { some: { normalizedValue: '09121234567' } } } },
    });
  });

  it('a non-mobile digit-ish search probes phone normalized values with contains', async () => {
    const { service, getWhere } = makeService();
    await service.list(COMPANY, { userId: 'u1', scope: 'ALL' }, { search: '55667788' } as never);

    const clauses = orClauses(getWhere());
    expect(clauses).toContainEqual({
      phones: { some: { normalizedValue: { contains: '55667788' } } },
    });
    expect(clauses).toContainEqual({
      contacts: { some: { phones: { some: { normalizedValue: { contains: '55667788' } } } } },
    });
  });

  it('company + scope filters stay outside the search OR block', async () => {
    const { service, getWhere } = makeService();
    await service.list(COMPANY, { userId: 'u1', scope: 'OWN' }, { search: 'آریا' } as never);
    expect(getWhere()).toMatchObject({ companyId: COMPANY, ownerUserId: 'u1' });
    expect(orClauses(getWhere()).length).toBeGreaterThan(0);
  });

  describeIntegration('corr-01 integration (live DB)', () => {
    const prisma = integrationPrisma();
    const marker = Date.now();
    const FIX = {
      nameFa: `شرکت جست‌وجوی کامل کُر ${marker}`,
      nameEn: `Complete Search Corr ${marker}`,
      internalCode: `IC-CORR01-${marker}`,
      nationalId: `411${String(marker).slice(-7)}`,
      nationalCode: `007${String(marker).slice(-7)}`,
      economicCode: `4113${String(marker).slice(-6)}`,
      registrationNumber: `REG${String(marker).slice(-6)}`,
      mobile: `0912${String(marker).slice(-7)}`,
      contactPhone: `02155${String(marker).slice(-6)}`,
    };
    let partyId: string;
    const createdPartyIds: string[] = [];
    const createdContactIds: string[] = [];

    beforeAll(async () => {
      const party = await prisma.party.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          type: 'COMPANY',
          nameFa: FIX.nameFa,
          nameEn: FIX.nameEn,
          internalCode: FIX.internalCode,
          nationalId: FIX.nationalId,
          nationalCode: FIX.nationalCode,
          economicCode: FIX.economicCode,
          registrationNumber: FIX.registrationNumber,
          phones: {
            create: {
              companyId: INTEGRATION_COMPANY_ID,
              kind: 'MOBILE',
              rawValue: FIX.mobile,
              normalizedValue: FIX.mobile,
              isPrimary: true,
            },
          },
          contacts: {
            create: {
              companyId: INTEGRATION_COMPANY_ID,
              name: `همراه تماس ${marker}`,
              phones: {
                create: {
                  kind: 'PHONE',
                  rawValue: FIX.contactPhone,
                  normalizedValue: FIX.contactPhone,
                },
              },
            },
          },
        },
      });
      partyId = party.id;
      createdPartyIds.push(party.id);
    });

    async function searchFinds(search: string): Promise<boolean> {
      const service = new PartiesService(
        prisma as never,
        { record: jest.fn(), recordTx: jest.fn() } as never,
        new TimelineService(prisma as never),
      );
      const result = await service.list(
        INTEGRATION_COMPANY_ID,
        { userId: 'u1', scope: 'ALL' },
        { search } as never,
      );
      return result.items.some((item) => item.id === partyId);
    }

    it('corr-01a: name_fa (ilike over the trgm index)', async () => {
      expect(await searchFinds('جست‌وجوی کامل')).toBe(true);
    });

    it('corr-01b: name_en (ilike, case-insensitive)', async () => {
      expect(await searchFinds(`complete search corr`)).toBe(true);
    });

    it('corr-01c: internal_code (ilike prefix/fragment)', async () => {
      expect(await searchFinds(`ic-corr01-${marker}`)).toBe(true);
    });

    it('corr-01d: phone — party mobile via +98 spelling AND contact phone fragment', async () => {
      expect(await searchFinds(`+98 ${FIX.mobile.slice(1)}`)).toBe(true);
      expect(await searchFinds(FIX.contactPhone)).toBe(true);
    });

    it('corr-01e: national_id (exact equals)', async () => {
      expect(await searchFinds(FIX.nationalId)).toBe(true);
      // A one-digit change does NOT match (equals, not contains).
      expect(await searchFinds(`${FIX.nationalId}9`)).toBe(false);
    });

    it('corr-01f: national_code (exact equals)', async () => {
      expect(await searchFinds(FIX.nationalCode)).toBe(true);
    });

    it('corr-01g: economic_code (ilike contains)', async () => {
      expect(await searchFinds(`4113${String(marker).slice(-6)}`)).toBe(true);
    });

    it('corr-01h: registration_number (ilike contains)', async () => {
      expect(await searchFinds(`reg${String(marker).slice(-6)}`)).toBe(true);
    });

    afterAll(async () => {
      if (createdContactIds.length) {
        await prisma.contactPhone.deleteMany({ where: { contactId: { in: createdContactIds } } });
        await prisma.contact.deleteMany({ where: { id: { in: createdContactIds } } });
      }
      if (createdPartyIds.length) {
        await prisma.timelineEvent.deleteMany({
          where: { entityType: 'PARTY', entityId: { in: createdPartyIds } },
        });
        await prisma.party.deleteMany({ where: { id: { in: createdPartyIds } } });
      }
      await disconnectIntegrationPrisma();
    });
  });
});
