import { PermissionsService } from './permissions.service';

function makePrismaMock(
  roleIds: string[],
  rolePermissionCodes: string[],
  overrides: { mode: 'GRANT' | 'REVOKE'; code: string }[],
) {
  return {
    userCompanyRole: {
      findMany: jest.fn().mockResolvedValue(roleIds.map((roleId) => ({ roleId }))),
    },
    rolePermission: {
      findMany: jest.fn().mockResolvedValue(
        rolePermissionCodes.map((code) => ({ permission: { code } })),
      ),
    },
    userPermissionOverride: {
      findMany: jest.fn().mockResolvedValue(
        overrides.map((o) => ({ mode: o.mode, permission: { code: o.code } })),
      ),
    },
  } as const;
}

describe('PermissionsService.getEffectivePermissions', () => {
  it('returns role permissions unchanged without overrides', async () => {
    const prisma = makePrismaMock(['r1'], ['users.view', 'users.create'], []);
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions('u1', 'company-A');

    expect([...effective].sort()).toEqual(['users.create', 'users.view']);
    expect(prisma.userCompanyRole.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1', companyId: 'company-A' },
      select: { roleId: true },
    });
  });

  it('subtracts REVOKE overrides from role permissions', async () => {
    const prisma = makePrismaMock(
      ['r1'],
      ['users.view', 'users.create', 'users.delete'],
      [{ mode: 'REVOKE', code: 'users.delete' }],
    );
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions('u1', 'company-A');

    expect([...effective].sort()).toEqual(['users.create', 'users.view']);
  });

  it('adds GRANT overrides the user has through no role', async () => {
    const prisma = makePrismaMock(['r1'], ['users.view'], [
      { mode: 'GRANT', code: 'audit.view' },
    ]);
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions('u1', 'company-A');

    expect([...effective].sort()).toEqual(['audit.view', 'users.view']);
  });

  it('applies the full formula: roles − REVOKE + GRANT', async () => {
    const prisma = makePrismaMock(
      ['r1', 'r2'],
      ['users.view', 'users.create', 'roles.view'],
      [
        { mode: 'REVOKE', code: 'users.create' },
        { mode: 'GRANT', code: 'sequences.edit' },
      ],
    );
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions('u1', 'company-A');

    expect([...effective].sort()).toEqual(['roles.view', 'sequences.edit', 'users.view']);
  });

  it('handles a user with no roles (overrides only)', async () => {
    const prisma = makePrismaMock([], [], [{ mode: 'GRANT', code: 'settings.view' }]);
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions('u1', 'company-A');

    expect([...effective]).toEqual(['settings.view']);
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('the null company (platform context) reads NO company roles', async () => {
    const prisma = makePrismaMock(['r1'], ['users.view'], []);
    const service = new PermissionsService(prisma as never);

    const effective = await service.getEffectivePermissions('u1', null);

    expect([...effective]).toEqual([]);
    expect(prisma.userCompanyRole.findMany).not.toHaveBeenCalled();
    expect(prisma.userPermissionOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'u1', OR: [{ companyId: null }, { companyId: null }] },
      }),
    );
  });
});
