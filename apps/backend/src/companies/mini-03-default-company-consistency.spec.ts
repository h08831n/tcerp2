import {
  CompaniesService,
  computeDefaultCompanyRepairs,
} from './companies.service';

/**
 * MINI-GATE 03 — default-company-consistency:
 * UserCompany no longer has an isDefault column — users.default_company_id is
 * the single canonical source. Company creation must set defaultCompanyId only
 * when the user had none, and ensureDefaultCompanyIntegrity() must repair rows
 * whose default points at a company they are no longer a member of.
 */

const ACTOR = { id: 'user-1', username: 'ali' };

function makeMocks(user: { id: string; defaultCompanyId: string | null } | null) {
  const trx = {
    company: {
      create: jest.fn(async (args: { data: object }) => ({ id: 'company-new', ...args.data })),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn(async (args: { where: { id: string }; data: object }) => ({
        ...(user ?? { id: args.where.id }),
        ...args.data,
      })),
    },
    userCompany: {
      create: jest.fn(async (args: { data: object }) => ({ id: 'uc-1', ...args.data })),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    ...trx,
    $transaction: jest.fn(async (fn: (t: unknown) => Promise<unknown>) => fn(trx)),
  };
  const audit = { record: jest.fn() };
  const service = new CompaniesService(prisma as never, audit as never);
  return { service, prisma, trx, audit };
}

describe('mini-03 default-company-consistency', () => {
  it('creating a company as a user WITHOUT a default sets defaultCompanyId', async () => {
    const { service, trx } = makeMocks({ id: 'user-1', defaultCompanyId: null });

    await service.create({ nameFa: 'شرکت نو' }, ACTOR, {});

    expect(trx.userCompany.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', companyId: 'company-new' },
    });
    expect(trx.userCompany.create).toHaveBeenCalledWith(
      expect.not.objectContaining({ isDefault: expect.anything() }),
    );
    expect(trx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { defaultCompanyId: 'company-new' },
    });
  });

  it('creating a company as a user WITH a default keeps the existing default', async () => {
    const { service, trx } = makeMocks({ id: 'user-1', defaultCompanyId: 'company-old' });

    await service.create({ nameFa: 'شرکت دوم' }, ACTOR, {});

    expect(trx.userCompany.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', companyId: 'company-new' },
    });
    expect(trx.user.update).not.toHaveBeenCalled();
  });

  it('computeDefaultCompanyRepairs: dangling default → first membership', () => {
    const repairs = computeDefaultCompanyRepairs(
      [{ id: 'u1', defaultCompanyId: 'company-A' }],
      [{ userId: 'u1', companyId: 'company-B' }],
    );
    expect(repairs).toEqual([{ userId: 'u1', defaultCompanyId: 'company-B' }]);
  });

  it('computeDefaultCompanyRepairs: dangling default with no memberships → null', () => {
    const repairs = computeDefaultCompanyRepairs(
      [{ id: 'u1', defaultCompanyId: 'company-A' }],
      [],
    );
    expect(repairs).toEqual([{ userId: 'u1', defaultCompanyId: null }]);
  });

  it('computeDefaultCompanyRepairs: consistent rows and null defaults are untouched', () => {
    const repairs = computeDefaultCompanyRepairs(
      [
        { id: 'u1', defaultCompanyId: 'company-A' },
        { id: 'u2', defaultCompanyId: null },
      ],
      [
        { userId: 'u1', companyId: 'company-A' },
        { userId: 'u1', companyId: 'company-B' },
        { userId: 'u2', companyId: 'company-C' },
      ],
    );
    expect(repairs).toEqual([]);
  });

  it('ensureDefaultCompanyIntegrity repairs violating rows and returns the count', async () => {
    const trx = {
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'u1', defaultCompanyId: 'company-A' },
          { id: 'u2', defaultCompanyId: 'company-B' },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
      userCompany: {
        findMany: jest.fn().mockResolvedValue([
          { userId: 'u1', companyId: 'company-B' },
          { userId: 'u2', companyId: 'company-B' },
        ]),
      },
    };

    const repaired = await new CompaniesService(trx as never, {
      record: jest.fn(),
    } as never).ensureDefaultCompanyIntegrity();

    expect(repaired).toBe(1);
    expect(trx.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { defaultCompanyId: 'company-B' },
    });
  });
});
