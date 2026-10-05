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
  SetUserRolesDto,
  UpdateUserDto,
  UserQueryDto,
} from './users.dto';
import { Paginated } from '../common/dto/pagination.dto';

const BCRYPT_ROUNDS = 10;

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
  roles: { select: { role: { select: { id: true, code: true, nameFa: true, nameEn: true } } } },
} satisfies Prisma.UserSelect;

export type UserWithRoles = Prisma.UserGetPayload<{ select: typeof USER_LIST_SELECT }>;

function toProfile(user: UserWithRoles): Record<string, unknown> {
  const { roles, ...rest } = user;
  return {
    ...rest,
    roles: roles.map(({ role }) => ({
      id: role.id,
      code: role.code,
      nameFa: role.nameFa,
      nameEn: role.nameEn,
    })),
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
    const roleIds = dto.roleIds ?? [];

    const user = await this.prisma.$transaction(async (trx) => {
      if (roleIds.length > 0) {
        const count = await trx.role.count({ where: { id: { in: roleIds } } });
        if (count !== roleIds.length) {
          throw new ValidationError('One or more role ids do not exist', { roleIds });
        }
      }
      return trx.user.create({
        data: {
          username: dto.username,
          email: dto.email?.toLowerCase(),
          passwordHash,
          firstName: dto.firstName,
          lastName: dto.lastName,
          mobile,
          language: dto.language ?? 'fa',
          timezone: dto.timezone ?? 'Asia/Tehran',
          roles: { create: roleIds.map((roleId) => ({ roleId })) },
        },
        select: USER_LIST_SELECT,
      });
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

  async setRoles(
    id: string,
    dto: SetUserRolesDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<UserWithRoles> {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      include: { roles: { select: { roleId: true } } },
    });
    if (!existing) throw new NotFoundError('User not found', { id });

    const uniqueIds = [...new Set(dto.roleIds)];
    const count = await this.prisma.role.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) {
      throw new ValidationError('One or more role ids do not exist', { roleIds: uniqueIds });
    }

    const oldRoleIds = existing.roles.map((r) => r.roleId).sort();
    const newRoleIds = [...uniqueIds].sort();

    if (oldRoleIds.join(',') !== newRoleIds.join(',')) {
      await this.prisma.$transaction([
        this.prisma.userRole.deleteMany({ where: { userId: id } }),
        this.prisma.userRole.createMany({
          data: uniqueIds.map((roleId) => ({ userId: id, roleId })),
        }),
      ]);
      await this.auditService.record({
        entityType: 'user',
        entityId: id,
        action: AuditAction.ROLES_CHANGED,
        actor,
        oldValues: { roleIds: oldRoleIds },
        newValues: { roleIds: newRoleIds },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return this.getById(id);
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
