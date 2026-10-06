import { PermissionsService } from './permissions.service';

/**
 * MINI-GATE 01 — role-in-company-a-does-not-leak-to-b:
 * Ali is SALES_MANAGER in company A and SALESPERSON in company B. Resolving
 * effective permissions in B must use ONLY the B assignments — the
 * manager-only codes granted in A must not appear in B.
 */

const SALES_MANAGER_ONLY = ['claims.edit', 'audit.view', 'loading.create'];
const SALESPERSON = ['claims.view', 'claims.create', 'files.view', 'queue.view'];

const ROLE_CODES: Record<string, string[]> = {
  'role-sales-manager': ['claims.view', 'claims.create', ...SALES_MANAGER_ONLY],
  'role-salesperson': SALESPERSON,
};

function makePrismaMock(assignments: { companyId: string; roleId: string }[]) {
  return {
    userCompanyRole: {
      findMany: jest.fn(async (args: { where: { userId: string; companyId: string } }) =>
        assignments.filter((a) => a.companyId === args.where.companyId),
      ),
    },
    rolePermission: {
      findMany: jest.fn(async (args: { where: { roleId: { in: string[] } } }) =>
        args.where.roleId.in.flatMap((roleId) =>
          (ROLE_CODES[roleId] ?? []).map((code) => ({ permission: { code } })),
        ),
      ),
    },
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

describe('mini-01 role-in-company-a-does-not-leak-to-b', () => {
  const ali = 'user-ali';
  const companyA = 'company-A';
  const companyB = 'company-B';

  // Ali: SALES_MANAGER in A, SALESPERSON in B.
  const assignments = [
    { companyId: companyA, roleId: 'role-sales-manager' },
    { companyId: companyB, roleId: 'role-salesperson' },
  ];

  it('in company A Ali holds the sales-manager codes', async () => {
    const prisma = makePrismaMock(assignments);
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions(ali, companyA);

    for (const code of SALES_MANAGER_ONLY) {
      expect(effective.has(code)).toBe(true);
    }
  });

  it('in company B Ali lacks the sales-manager-only codes', async () => {
    const prisma = makePrismaMock(assignments);
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions(ali, companyB);

    for (const code of SALES_MANAGER_ONLY) {
      expect(effective.has(code)).toBe(false);
    }
    for (const code of SALESPERSON) {
      expect(effective.has(code)).toBe(true);
    }
  });

  it('only the company asked for is read (no cross-company role fetch)', async () => {
    const prisma = makePrismaMock(assignments);
    const service = new PermissionsService(prisma as never);

    await service.getEffectivePermissions(ali, companyB);

    expect(prisma.userCompanyRole.findMany).toHaveBeenCalledWith({
      where: { userId: ali, companyId: companyB },
      select: { roleId: true },
    });
  });
});
