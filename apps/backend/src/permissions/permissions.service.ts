import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface PermissionOverrideRow {
  mode: 'GRANT' | 'REVOKE';
  code: string;
}

/**
 * Effective permission resolution, company-scoped (Mini-Gate):
 *   (permission codes of the user's roles in THIS company)
 *   − REVOKE overrides scoped to this company or platform-wide
 *   + GRANT overrides scoped to this company or platform-wide.
 *
 * Override scope: `companyId = null` on an override means platform-wide —
 * it applies in every company the user is a member of. `companyId = X`
 * applies only in X. Role assignments live in user_company_roles; the same
 * user may hold different roles in different companies.
 *
 * Structured so a Redis cache can wrap `getEffectivePermissions` later:
 * `loadRaw` performs all DB reads; cache invalidation hooks in on permission
 * changes go in a single place.
 */
@Injectable()
export class PermissionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Pure override arithmetic: start from the role codes, subtract REVOKEs,
   * then add GRANTs (a GRANT re-enables a code even when REVOKEd by a
   * platform-wide override). Exposed for unit tests without a DB.
   */
  applyOverrides(codes: Iterable<string>, overrides: PermissionOverrideRow[]): Set<string> {
    const effective = new Set(codes);
    for (const override of overrides) {
      if (override.mode === 'REVOKE') {
        effective.delete(override.code);
      }
    }
    for (const override of overrides) {
      if (override.mode === 'GRANT') {
        effective.add(override.code);
      }
    }
    return effective;
  }

  private async loadRaw(
    userId: string,
    companyId: string | null,
  ): Promise<{ codes: string[]; overrides: PermissionOverrideRow[] }> {
    // Roles are company-scoped: only assignments in THIS company count.
    // companyId === null → platform context: no company roles exist, only
    // platform-wide overrides apply.
    const companyRoles = companyId
      ? await this.prisma.userCompanyRole.findMany({
          where: { userId, companyId },
          select: { roleId: true },
        })
      : [];
    const roleIds = companyRoles.map((ur) => ur.roleId);

    const [rolePermissions, overrides] = await Promise.all([
      roleIds.length
        ? this.prisma.rolePermission.findMany({
            where: { roleId: { in: roleIds } },
            select: { permission: { select: { code: true } } },
          })
        : Promise.resolve([]),
      // Overrides of this company OR platform-wide (companyId null).
      this.prisma.userPermissionOverride.findMany({
        where: {
          userId,
          OR: [{ companyId }, { companyId: null }],
        },
        select: { mode: true, permission: { select: { code: true } } },
      }),
    ]);

    return {
      codes: rolePermissions.map((rp) => rp.permission.code),
      overrides: overrides.map((o) => ({
        mode: o.mode as 'GRANT' | 'REVOKE',
        code: o.permission.code,
      })),
    };
  }

  /**
   * Effective permissions of `userId` within `companyId`.
   * `companyId === null` is the platform context: no company roles, only
   * platform-wide (companyId IS NULL) overrides apply.
   */
  async getEffectivePermissions(
    userId: string,
    companyId: string | null,
  ): Promise<Set<string>> {
    // TODO(cache): wrap with Redis (REQUIREMENTS architecture doc) — read
    // through cache keyed by (userId, companyId), invalidate on role/override
    // changes.
    const { codes, overrides } = await this.loadRaw(userId, companyId);
    return this.applyOverrides(codes, overrides);
  }
}
