import { PermissionsService } from './permissions.service';

/**
 * MINI-GATE 02 — permission-override-company-scope:
 * a GRANT override stored with companyId = A must NOT apply in company B,
 * while a platform-wide (companyId = null) override applies in both.
 * REVOKE follows the same scoping rule.
 */

const SALES_MANAGER_ONLY = ['claims.edit', 'audit.view'];

function makePrismaMock(
  assignments: { companyId: string; roleId: string }[],
  overrides: ({ companyId: string | null; mode: 'GRANT' | 'REVOKE'; code: string } | {
    companyId: string | null;
    mode: 'GRANT' | 'REVOKE';
    code: string;
  })[],
) {
  return {
    userCompanyRole: {
      findMany: jest.fn(async (args: { where: { userId: string; companyId: string } }) =>
        assignments.filter((a) => a.companyId === args.where.companyId),
      ),
    },
    rolePermission: {
      findMany: jest.fn(async (args: { where: { roleId: { in: string[] } } }) =>
        args.where.roleId.in.flatMap((roleId) =>
          (roleId === 'role-sales-manager' ? ['claims.view', ...SALES_MANAGER_ONLY] : []).map(
            (code) => ({ permission: { code } }),
          ),
        ),
      ),
    },
    userPermissionOverride: {
      findMany: jest.fn(async (args: { where: { userId: string; OR: { companyId: string | null }[] } }) => {
        const allowed = args.where.OR.map((o) => o.companyId);
        return overrides
          .filter((o) => allowed.includes(o.companyId))
          .map((o) => ({ mode: o.mode, permission: { code: o.code } }));
      }),
    },
  };
}

describe('mini-02 permission-override-company-scope', () => {
  const user = 'user-1';
  const companyA = 'company-A';
  const companyB = 'company-B';
  const assignments = [{ companyId: companyA, roleId: 'role-sales-manager' }];

  it('a company-A GRANT override does NOT apply in company B', async () => {
    const prisma = makePrismaMock(assignments, [
      { companyId: companyA, mode: 'GRANT', code: 'treasury.view' },
    ]);
    const service = new PermissionsService(prisma as never);

    const inA = await service.getEffectivePermissions(user, companyA);
    const inB = await service.getEffectivePermissions(user, companyB);

    expect(inA.has('treasury.view')).toBe(true);
    expect(inB.has('treasury.view')).toBe(false);
    expect(inB.size).toBe(0);
  });

  it('a platform-wide (null company) GRANT override applies in both companies', async () => {
    const prisma = makePrismaMock(assignments, [
      { companyId: null, mode: 'GRANT', code: 'treasury.view' },
    ]);
    const service = new PermissionsService(prisma as never);

    const inA = await service.getEffectivePermissions(user, companyA);
    const inB = await service.getEffectivePermissions(user, companyB);

    expect(inA.has('treasury.view')).toBe(true);
    expect(inB.has('treasury.view')).toBe(true);
  });

  it('a company-A REVOKE does not strip the code in company B', async () => {
    const prisma = makePrismaMock(
      [
        { companyId: companyA, roleId: 'role-sales-manager' },
        { companyId: companyB, roleId: 'role-sales-manager' },
      ],
      [{ companyId: companyA, mode: 'REVOKE', code: 'claims.edit' }],
    );
    const service = new PermissionsService(prisma as never);

    const inA = await service.getEffectivePermissions(user, companyA);
    const inB = await service.getEffectivePermissions(user, companyB);

    expect(inA.has('claims.edit')).toBe(false);
    expect(inB.has('claims.edit')).toBe(true);
  });

  it('a platform-wide REVOKE strips the code in both companies', async () => {
    const prisma = makePrismaMock(
      [
        { companyId: companyA, roleId: 'role-sales-manager' },
        { companyId: companyB, roleId: 'role-sales-manager' },
      ],
      [{ companyId: null, mode: 'REVOKE', code: 'claims.edit' }],
    );
    const service = new PermissionsService(prisma as never);

    const inA = await service.getEffectivePermissions(user, companyA);
    const inB = await service.getEffectivePermissions(user, companyB);

    expect(inA.has('claims.edit')).toBe(false);
    expect(inB.has('claims.edit')).toBe(false);
  });

  it('a company GRANT beats a platform-wide REVOKE in that company only', async () => {
    const prisma = makePrismaMock(assignments, [
      { companyId: null, mode: 'REVOKE', code: 'claims.edit' },
      { companyId: companyA, mode: 'GRANT', code: 'claims.edit' },
    ]);
    const service = new PermissionsService(prisma as never);

    const inA = await service.getEffectivePermissions(user, companyA);
    expect(inA.has('claims.edit')).toBe(true);
  });
});
