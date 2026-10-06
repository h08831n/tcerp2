import { ConflictError } from '../common/errors';
import { Prisma } from '@prisma/client';
import { PortalAccountService } from './portal.service';
import { describeIntegration, integrationPrisma, INTEGRATION_COMPANY_ID, testUuid, disconnectIntegrationPrisma } from '../testing/integration';

/**
 * MINI-GATE 04 — portal-website-user-unique-per-company:
 * one website user may link to at most one Party PER COMPANY. The DB enforces
 * it with the partial unique index `portal_accounts_website_user_uniq`
 * ((company_id, website_user_id) WHERE website_user_id IS NOT NULL); the
 * service enforces it too so callers get a typed ConflictError.
 */
describe('mini-04 portal-website-user-unique-per-company', () => {
  const COMPANY = 'company-1';

  function makeMocks(existing: { verifiedMobile: string; websiteUserId: string | null }[]) {
    const created: object[] = [];
    const prisma = {
      portalAccount: {
        findMany: jest.fn().mockResolvedValue(existing),
        create: jest.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }),
      },
    };
    const service = new PortalAccountService(prisma as never, { record: jest.fn() } as never);
    return { service, prisma, created };
  }

  it('the service rejects a websiteUserId already linked in the same company', async () => {
    const { service } = makeMocks([{ verifiedMobile: '09120000001', websiteUserId: 'web-1' }]);
    await expect(
      service.create(
        COMPANY,
        { partyId: testUuid(), websiteUserId: 'web-1', verifiedMobile: '09120000002' },
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('the service rejects a verifiedMobile already registered in the same company', async () => {
    const { service } = makeMocks([{ verifiedMobile: '09120000001', websiteUserId: null }]);
    await expect(
      service.create(
        COMPANY,
        { partyId: testUuid(), verifiedMobile: '09120000001' },
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'PORTAL_LINK_EXISTS' });
  });

  it('a P2002 from the partial unique index maps to ConflictError PORTAL_LINK_EXISTS', async () => {
    const { service } = makeMocks([]); // no service-level clash, DB race
    await expect(
      service.create(
        COMPANY,
        { partyId: testUuid(), websiteUserId: 'web-2', verifiedMobile: '09120000003' },
        { id: 'u1', username: 'a' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'PORTAL_LINK_EXISTS' });
  });

  describeIntegration('mini-04 integration (live DB)', () => {
    it('a second raw row with the same (company, website_user_id) violates the partial unique index', async () => {
      const prisma = integrationPrisma();
      const company = INTEGRATION_COMPANY_ID;
      const websiteUserId = `web-${Date.now()}`;
      await prisma.portalAccount.deleteMany({ where: { companyId: company, websiteUserId } });

      const first = await prisma.portalAccount.create({
        data: {
          companyId: company,
          partyId: testUuid(),
          websiteUserId,
          verifiedMobile: `0912${String(Date.now()).slice(-8)}`,
        },
      });

      await expect(
        prisma.$executeRaw`INSERT INTO portal_accounts (id, company_id, party_id, website_user_id, verified_mobile, status, created_at)
          VALUES (${testUuid()}::uuid, ${company}::uuid, ${testUuid()}::uuid, ${websiteUserId}, '09121112233', 'PENDING', now())`,
      ).rejects.toThrow();

      await prisma.portalAccount.delete({ where: { id: first.id } });
      await disconnectIntegrationPrisma();
    }, 20_000);
  });
});
