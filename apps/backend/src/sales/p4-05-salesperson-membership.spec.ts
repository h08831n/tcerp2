import { ValidationError } from '../common/errors';
import { assertActiveCompanyMember } from '../common/utils/company-member';

/**
 * p4-05 salesperson-company-membership: an assigned salesperson must be an
 * ACTIVE member of the sales document's company (corr-03 pattern, Phase 4).
 */
describe('p4-05 salesperson-company-membership', () => {
  function makePrisma(member: unknown) {
    return {
      userCompany: { findFirst: jest.fn(async () => member) },
    };
  }

  it('a non-member user is rejected (SALESPERSON_NOT_COMPANY_MEMBER)', async () => {
    const prisma = makePrisma(null);
    await expect(
      assertActiveCompanyMember(prisma as never, 'c1', 'user-1', 'SALESPERSON_NOT_COMPANY_MEMBER'),
    ).rejects.toMatchObject({ statusCode: 422, message: 'SALESPERSON_NOT_COMPANY_MEMBER' });
  });

  it('membership is checked with users.status = ACTIVE', async () => {
    const prisma = makePrisma({ userId: 'user-1' });
    await assertActiveCompanyMember(prisma as never, 'c1', 'user-1', 'SALESPERSON_NOT_COMPANY_MEMBER');
    const args = (prisma.userCompany.findFirst as jest.Mock).mock.calls[0][0] as {
      where: { companyId: string; userId: string; user: { status: string } };
    };
    expect(args.where.companyId).toBe('c1');
    expect(args.where.userId).toBe('user-1');
    expect(args.where.user.status).toBe('ACTIVE');
  });

  it('the default message token is USER_NOT_COMPANY_MEMBER', async () => {
    const prisma = makePrisma(null);
    await expect(assertActiveCompanyMember(prisma as never, 'c1', 'u')).rejects.toMatchObject({
      message: 'USER_NOT_COMPANY_MEMBER',
    });
    expect(new ValidationError('X')).toBeInstanceOf(ValidationError);
  });
});
