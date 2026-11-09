import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import { Prisma, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../common/errors';
import { normalizeIranMobile } from '../common/utils/phone';
import { RequestContext } from '../auth/auth.service';
import {
  CreateUserDto,
  ResetPasswordDto,
  SetUserCompanyRolesDto,
  UpdateUserDto,
  UserQueryDto,
} from './users.dto';
import { Paginated } from '../common/dto/pagination.dto';

export const BCRYPT_ROUNDS = 10;

const USER_LIST_SELECT = {
  id: true,
  username: true,
  email: true,
  firstName: true,
  lastName: true,
  mobile: true,
  status: true,
  language: true,
  timezone: true,
  version: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  // Mini-Gate: roles are company-scoped assignments (user_company_roles).
  companyRoles: {
    orderBy: { companyId: 'asc' as const },
    select: {
      companyId: true,
      role: { select: { id: true, code: true, nameFa: true, nameEn: true } },
    },
  },
} satisfies Prisma.UserSelect;

export type UserWithRoles = Prisma.UserGetPayload<{ select: typeof USER_LIST_SELECT }>;

export interface CompanyRolesGroup {
  companyId: string;
  roles: { id: string; code: string; nameFa: string; nameEn: string }[];
}

/** Group flat user_company_roles rows by company (pure — unit-testable). */
export function groupRolesByCompany(
  assignments: { companyId: string; role: { id: string; code: string; nameFa: string; nameEn: string } }[],
): CompanyRolesGroup[] {
  const groups = new Map<string, CompanyRolesGroup>();
  for (const { companyId, role } of assignments) {
    const group = groups.get(companyId) ?? { companyId, roles: [] };
    group.roles.push(role);
    groups.set(companyId, group);
  }
  return [...groups.values()];
}

function toProfile(user: UserWithRoles): Record<string, unknown> {
  const { companyRoles, ...rest } = user;
  return {
    ...rest,
    rolesByCompany: groupRolesByCompany(companyRoles),
  };
}

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(query: UserQueryDto): Promise<Paginated<UserWithRoles>> {
    const where: Prisma.UserWhereInput = {
      status: query.status,
    };
    if (query.search) {
      const s = { contains: query.search, mode: 'insensitive' as const };
      where.OR = [
        { username: s },
        { email: s },
        { firstName: s },
        { lastName: s },
      ];
    }

    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: USER_LIST_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(id: string): Promise<UserWithRoles> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: USER_LIST_SELECT,
    });
    if (!user) throw new NotFoundError('User not found', { id });
    return user;
  }

  async create(dto: CreateUserDto, actor: { id: string; username: string }, ctx: RequestContext): Promise<UserWithRoles> {
    await this.assertNoDuplicate(dto.username, dto.email);

    let mobile: string | undefined;
    if (dto.mobile !== undefined) {
      mobile = normalizeIranMobile(dto.mobile);
    }

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Mini-Gate: roles are company-scoped, so user creation no longer takes a
    // global roleIds list — grant roles per company via
    // PUT /users/:id/companies/:companyId/roles (or membership creation).
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email?.toLowerCase(),
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        mobile,
        language: dto.language ?? 'fa',
        timezone: dto.timezone ?? 'Asia/Tehran',
      },
      select: USER_LIST_SELECT,
    });

    await this.auditService.record({
      entityType: 'user',
      entityId: user.id,
      action: AuditAction.CREATE,
      actor,
      newValues: toProfile(user),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return user;
  }

  async update(
    id: string,
    dto: UpdateUserDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<UserWithRoles> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('User not found', { id });

    // Optimistic locking (architecture doc: `version` on concurrently-edited records).
    if (dto.version !== existing.version) {
      throw new AppError(409, 'VERSION_CONFLICT', 'The record was modified by someone else; reload and retry', {
        expected: existing.version,
        received: dto.version,
      });
    }

    if (dto.email !== undefined && dto.email.toLowerCase() !== existing.email) {
      await this.assertNoDuplicate(undefined, dto.email);
    }

    let mobile: string | undefined | null;
    if (dto.mobile !== undefined) {
      mobile = dto.mobile === '' ? null : normalizeIranMobile(dto.mobile);
    }

    // IAM-001 S15: disabling the LAST active admin is refused (backend law).
    if (dto.status === 'DISABLED' && existing.status === 'ACTIVE') {
      const primaryCompanyId =
        existing.defaultCompanyId ??
        (await this.prisma.userCompany.findFirst({ where: { userId: id }, select: { companyId: true } }))?.companyId;
      if (primaryCompanyId) {
        await this.assertNotLastAdmin(primaryCompanyId, id, 'DISABLE');
      }
    }

    const data: Prisma.UserUpdateInput = {
      email: dto.email !== undefined ? dto.email.toLowerCase() : undefined,
      firstName: dto.firstName,
      lastName: dto.lastName,
      mobile,
      status: dto.status,
      language: dto.language,
      timezone: dto.timezone,
      mustChangePassword: dto.mustChangePassword,
      version: existing.version + 1,
    };

    let updated: UserWithRoles;
    try {
      updated = await this.prisma.user.update({
        where: { id, version: existing.version },
        data,
        select: USER_LIST_SELECT,
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        throw new AppError(409, 'VERSION_CONFLICT', 'The record was modified by someone else; reload and retry');
      }
      throw error;
    }

    await this.auditService.record({
      entityType: 'user',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      oldValues: this.snapshot(existing),
      newValues: toProfile(updated),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return updated;
  }

  /** Soft delete: disable the account, never destroy history. */
  async remove(id: string, actor: { id: string; username: string }, ctx: RequestContext): Promise<void> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('User not found', { id });

    // IAM-001 S15: the last active admin cannot be removed.
    if (existing.status === 'ACTIVE') {
      const primaryCompanyId =
        existing.defaultCompanyId ??
        (await this.prisma.userCompany.findFirst({ where: { userId: id }, select: { companyId: true } }))?.companyId;
      if (primaryCompanyId) {
        await this.assertNotLastAdmin(primaryCompanyId, id, 'DISABLE');
      }
    }

    await this.prisma.user.update({
      where: { id },
      data: { status: 'DISABLED' },
    });
    await this.auditService.record({
      entityType: 'user',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      oldValues: this.snapshot(existing),
      newValues: { status: 'DISABLED' },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  async resetPassword(
    id: string,
    dto: ResetPasswordDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const existing = await this.prisma.user.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('User not found', { id });

    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null },
    });
    // Invalidate all active sessions after an administrative password reset.
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.auditService.record({
      entityType: 'user',
      entityId: id,
      action: AuditAction.PASSWORD_RESET,
      actor,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  /**
   * Replace the target user's roles within ONE company (Mini-Gate #1).
   * The user must already be a member of the company (UserCompany row);
   * granting roles to a non-member is only possible together with membership
   * creation via the companies module.
   */
  async setCompanyRoles(
    id: string,
    companyId: string,
    dto: SetUserCompanyRolesDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<UserWithRoles> {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      include: { companyRoles: { select: { companyId: true, roleId: true } } },
    });
    if (!existing) throw new NotFoundError('User not found', { id });

    // IAM-001 §11: assigning a role to a user IN a company implies the
    // membership — create it here (audited) instead of refusing, so the UI
    // flow «ایجاد کاربر → تخصیص نقش» works without a separate step.
    const member = await this.prisma.userCompany.findUnique({
      where: { userId_companyId: { userId: id, companyId } },
      select: { userId: true },
    });
    const isNewMembership = !member;

    const uniqueIds = [...new Set(dto.roleIds)];
    const count = await this.prisma.role.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) {
      throw new ValidationError('One or more role ids do not exist', { roleIds: uniqueIds });
    }

    const oldRoleIds = existing.companyRoles
      .filter((r) => r.companyId === companyId)
      .map((r) => r.roleId)
      .sort();
    const newRoleIds = [...uniqueIds].sort();

    // ── IAM-001 §4/§11 admin-role assignment law (backend-enforced) ──
    const adminRole = await this.prisma.role.findUnique({ where: { code: 'admin' }, select: { id: true } });
    if (adminRole) {
      const actorHoldsAdmin = await this.prisma.userCompanyRole.findFirst({
        where: { userId: actor.id, companyId, roleId: adminRole.id },
        select: { userId: true },
      });
      const targetHoldsAdmin = oldRoleIds.includes(adminRole.id);
      // (a) Granting the admin role requires the ACTOR to already hold it —
      // a users.edit holder can never escalate themselves or anyone to admin.
      if (!actorHoldsAdmin && newRoleIds.includes(adminRole.id)) {
        throw new ValidationError('ADMIN_ROLE_ASSIGNMENT_FORBIDDEN', { userId: id, companyId });
      }
      // (b) Removing the admin role from the last active admin is refused;
      // an admin removing their OWN admin role is also refused (self-lockout)
      // unless another active admin exists.
      if (targetHoldsAdmin && !newRoleIds.includes(adminRole.id)) {
        await this.assertNotLastAdmin(companyId, id, 'REMOVE_ROLE');
        if (actor.id === id) {
          throw new ValidationError('SELF_ADMIN_ROLE_REMOVAL_FORBIDDEN', { userId: id, companyId });
        }
      }
    }


    if (oldRoleIds.join(',') !== newRoleIds.join(',')) {
      await this.prisma.$transaction([
        ...(isNewMembership
          ? [
              this.prisma.userCompany.create({ data: { userId: id, companyId } }),
              // First membership becomes the default company (same contract
              // as the companies module) — /auth/me resolves permissions
              // against THIS company afterwards.
              ...(existing.defaultCompanyId
                ? []
                : [this.prisma.user.update({ where: { id }, data: { defaultCompanyId: companyId } })]),
            ]
          : []),
        this.prisma.userCompanyRole.deleteMany({ where: { userId: id, companyId } }),
        this.prisma.userCompanyRole.createMany({
          data: uniqueIds.map((roleId) => ({ userId: id, companyId, roleId, assignedBy: actor.id })),
        }),
      ]);
      if (isNewMembership) {
        await this.auditService.record({
          entityType: 'user',
          entityId: id,
          action: AuditAction.UPDATE,
          actor,
          companyId,
          newValues: { membershipCreated: true, companyId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
      const removed = oldRoleIds.filter((r) => !newRoleIds.includes(r));
      const added = newRoleIds.filter((r) => !oldRoleIds.includes(r));
      if (removed.length > 0) {
        await this.auditService.record({
          entityType: 'user',
          entityId: id,
          action: AuditAction.ROLE_REMOVED,
          actor,
          companyId,
          oldValues: { companyId, roleIds: oldRoleIds },
          newValues: { companyId, roleIds: newRoleIds },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
      if (added.length > 0) {
        await this.auditService.record({
          entityType: 'user',
          entityId: id,
          action: AuditAction.ROLE_ASSIGNED,
          actor,
          companyId,
          oldValues: { companyId, roleIds: oldRoleIds },
          newValues: { companyId, roleIds: newRoleIds },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
    }

    return this.getById(id);
  }

  /**
   * IAM-001 S15 — last-admin protection (backend-enforced): the target user
   * holds the platform `admin` role in `companyId` AND no OTHER ACTIVE user
   * does → the requested action would leave the system without any admin.
   * The role that matters is the SEED admin role (code 'admin'), which the
   * seed grants ALL permissions.
   */
  private async assertNotLastAdmin(
    companyId: string,
    userId: string,
    action: 'DISABLE' | 'REMOVE_ROLE',
  ): Promise<void> {
    const adminRole = await this.prisma.role.findUnique({ where: { code: 'admin' }, select: { id: true } });
    if (!adminRole) return;
    const holdsAdmin = await this.prisma.userCompanyRole.findFirst({
      where: { userId, companyId, roleId: adminRole.id },
      select: { userId: true },
    });
    if (!holdsAdmin) return;
    const otherAdmins = await this.prisma.userCompanyRole.count({
      where: { companyId, roleId: adminRole.id, userId: { not: userId }, user: { status: 'ACTIVE' } },
    });
    if (otherAdmins === 0) {
      throw new ValidationError(
        action === 'DISABLE' ? 'LAST_ADMIN_CANNOT_BE_DISABLED' : 'LAST_ADMIN_CANNOT_LOSE_ROLE',
        { userId, companyId },
      );
    }
  }

  private async assertNoDuplicate(username?: string, email?: string): Promise<void> {
    const clash = await this.prisma.user.findFirst({
      where: {
        OR: [
          ...(username ? [{ username }] : []),
          ...(email ? [{ email: email.toLowerCase() }] : []),
        ],
      },
      select: { id: true, username: true, email: true },
    });
    if (clash) {
      if (username && clash.username === username) {
        throw new ConflictError('Username already exists', { field: 'username' });
      }
      throw new ConflictError('Email already exists', { field: 'email' });
    }
  }

  private snapshot(user: User): Record<string, unknown> {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }
}
