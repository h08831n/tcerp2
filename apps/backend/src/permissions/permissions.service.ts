import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Effective permission resolution:
 *   (role permission codes) − REVOKE overrides + GRANT overrides
 * (REQUIREMENTS §60: roles give defaults, per-user overrides handle special
 * cases).
 *
 * Structured so a Redis cache can wrap `getEffectivePermissions` later:
 * `loadRaw` performs all DB reads; cache invalidation hooks in on permission
 * changes go in a single place.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadRaw(
    userId: string,
  ): Promise<{ codes: string[]; overrides: { mode: 'GRANT' | 'REVOKE'; code: string }[] }> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      select: { roleId: true },
    });
    const roleIds = userRoles.map((ur) => ur.roleId);

    const [rolePermissions, overrides] = await Promise.all([
      roleIds.length
        ? this.prisma.rolePermission.findMany({
            where: { roleId: { in: roleIds } },
            select: { permission: { select: { code: true } } },
          })
        : Promise.resolve([]),
      this.prisma.userPermissionOverride.findMany({
        where: { userId },
        select: { mode: true, permission: { select: { code: true } } },
      }),
    ]);

    return {
      codes: rolePermissions.map((rp) => rp.permission.code),
      overrides: overrides.map((o) => ({
        mode: o.mode,
        code: o.permission.code,
      })),
    };
  }

  async getEffectivePermissions(userId: string): Promise<Set<string>> {
    // TODO(cache): wrap with Redis (REQUIREMENTS architecture doc) — read
    // through cache keyed by userId, invalidate on role/override changes.
    const { codes, overrides } = await this.loadRaw(userId);
    const effective = new Set(codes);
    for (const override of overrides) {
      if (override.mode === 'GRANT') {
        effective.add(override.code);
      } else {
        effective.delete(override.code);
      }
    }
    return effective;
  }
}
