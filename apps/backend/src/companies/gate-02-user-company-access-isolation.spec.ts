import { ForbiddenError } from '../common/errors';
import { CompanyContextService } from './company-context.service';

/**
 * GATE TEST 02 — user-company access isolation:
 *   - a non-member presenting x-company-id is rejected (ForbiddenError);
 *   - a member with the header gets exactly that company;
 *   - without a header, defaultCompanyId (or first membership) wins.
 *
 * Mini-Gate: UserCompany has no isDefault column — users.default_company_id
 * is the single canonical source; memberships() computes isDefault from it.
 */
describe('02 user-company-access-isolation', () => {
  const user = { id: 'user-1' };

  function makeService(
    membership: unknown | null,
    memberships: unknown[] = [],
    userRow: { defaultCompanyId: string | null } | null = null,
  ) {
    const prisma = {
      userCompany: {
        // Honour the queried companyId so isMember probes are meaningful.
        findUnique: jest.fn(
          async (args: { where: { userId_companyId: { userId: string; companyId: string } } }) => {
            const companyId = args.where.userId_companyId.companyId;
            const mem = membership as { companyId?: string } | null;
            return mem && mem.companyId === companyId ? mem : null;
          },
        ),
        findMany: jest.fn().mockResolvedValue(memberships),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue(userRow),
      },
    };
    return { service: new CompanyContextService(prisma as never), prisma };
  }

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

  it('without a header the default company wins', async () => {
    const { service } = makeService(
      null,
      [
        { companyId: 'company-A', company: { nameFa: 'A' } },
        { companyId: 'company-B', company: { nameFa: 'B' } },
      ],
      { defaultCompanyId: 'company-B' },
    );
    const companyId = await service.requireCompanyId(user, {});
    expect(companyId).toBe('company-B');
  });

  it('without a header and without default, the first membership wins', async () => {
    const { service } = makeService(
      null,
      [
        { companyId: 'company-A', company: { nameFa: 'A' } },
        { companyId: 'company-B', company: { nameFa: 'B' } },
      ],
      { defaultCompanyId: null },
    );
    expect(await service.requireCompanyId(user, {})).toBe('company-A');
  });

  it('a stale defaultCompanyId (membership removed) falls back to the first membership', async () => {
    const { service } = makeService(
      null,
      [
        { companyId: 'company-A', company: { nameFa: 'A' } },
        { companyId: 'company-B', company: { nameFa: 'B' } },
      ],
      { defaultCompanyId: 'company-GONE' },
    );
    expect(await service.requireCompanyId(user, {})).toBe('company-A');
  });

  it('a user with no memberships has no company context', async () => {
    const { service } = makeService(null, [], { defaultCompanyId: null });
    await expect(service.requireCompanyId(user, {})).rejects.toBeInstanceOf(ForbiddenError);
    expect(await service.resolveCompanyId(user, {})).toBeNull();
  });

  it('memberships() returns id + nameFa + isDefault computed from defaultCompanyId', async () => {
    const { service } = makeService(
      null,
      [
        { companyId: 'company-A', company: { nameFa: 'شرکت A' } },
        { companyId: 'company-B', company: { nameFa: 'شرکت B' } },
      ],
      { defaultCompanyId: 'company-A' },
    );
    expect(await service.memberships('user-1')).toEqual([
      { companyId: 'company-A', isDefault: true, nameFa: 'شرکت A' },
      { companyId: 'company-B', isDefault: false, nameFa: 'شرکت B' },
    ]);
  });

  it('resolveLenientCompanyId honours the header only for members, else the default company, else null', async () => {
    // Non-member header → falls back to default company (a member of it).
    const fallback = makeService(
      { userId: 'user-1', companyId: 'company-B' },
      [],
      { defaultCompanyId: 'company-B' },
    );
    expect(
      await fallback.service.resolveLenientCompanyId(user, { 'x-company-id': 'company-Z' }),
    ).toBe('company-B');

    // No membership anywhere → null (only platform-wide overrides apply).
    const none = makeService(null, [], { defaultCompanyId: null });
    expect(await none.service.resolveLenientCompanyId(user, {})).toBeNull();

    // No user → null.
    expect(
      await none.service.resolveLenientCompanyId(undefined, {}),
    ).toBeNull();
  });
});
