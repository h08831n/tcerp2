import { ForbiddenError } from '../common/errors';
import { CompanyContextService } from './company-context.service';

/**
 * GATE TEST 02 — user-company access isolation:
 *   - a non-member presenting x-company-id is rejected (ForbiddenError);
 *   - a member with the header gets exactly that company;
 *   - without a header, defaultCompanyId (or first membership) wins.
 */
describe('02 user-company-access-isolation', () => {
  function makeService(membership: unknown | null, memberships: unknown[] = []) {
    const prisma = {
      userCompany: {
        findUnique: jest.fn().mockResolvedValue(membership),
        findMany: jest.fn().mockResolvedValue(memberships),
      },
    };
    return { service: new CompanyContextService(prisma as never), prisma };
  }

  const user = { id: 'user-1' };

  it('rejects a non-member who presents x-company-id', async () => {
    const { service } = makeService(null);
    await expect(
      service.requireCompanyId(user, { 'x-company-id': 'company-Z' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a member with the header resolves exactly that company', async () => {
    const { service, prisma } = makeService({ userId: 'user-1', companyId: 'company-B' });
    const companyId = await service.requireCompanyId(user, { 'x-company-id': 'company-B' });
    expect(companyId).toBe('company-B');
    expect(prisma.userCompany.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId_companyId: { userId: 'user-1', companyId: 'company-B' } },
      }),
    );
  });

  it('without a header the default membership wins', async () => {
    const { service } = makeService(null, [
      { companyId: 'company-A', isDefault: false, company: { nameFa: 'A' } },
      { companyId: 'company-B', isDefault: true, company: { nameFa: 'B' } },
    ]);
    const companyId = await service.requireCompanyId(user, {});
    expect(companyId).toBe('company-B');
  });

  it('without a header and without default, the first membership wins', async () => {
    const { service } = makeService(null, [
      { companyId: 'company-A', isDefault: false, company: { nameFa: 'A' } },
      { companyId: 'company-B', isDefault: false, company: { nameFa: 'B' } },
    ]);
    expect(await service.requireCompanyId(user, {})).toBe('company-A');
  });

  it('a user with no memberships has no company context', async () => {
    const { service } = makeService(null, []);
    await expect(service.requireCompanyId(user, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(await service.resolveCompanyId(user, {})).toBeNull();
  });

  it('memberships() returns id + nameFa + isDefault (auth/me shape)', async () => {
    const { service } = makeService(null, [
      { companyId: 'company-A', isDefault: true, company: { nameFa: 'شرکت A' } },
    ]);
    expect(await service.memberships('user-1')).toEqual([
      { companyId: 'company-A', isDefault: true, nameFa: 'شرکت A' },
    ]);
  });
});
