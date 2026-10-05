import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../common/errors';
import { RequestContext } from '../auth/auth.service';
import { CreateRoleDto, RoleQueryDto, SetRolePermissionsDto, UpdateRoleDto } from './roles.dto';
import { Paginated } from '../common/dto/pagination.dto';

const ROLE_SELECT = {
  id: true,
  code: true,
  nameFa: true,
  nameEn: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  permissions: {
    select: { permission: { select: { id: true, code: true, module: true, action: true } } },
  },
} satisfies Prisma.RoleSelect;

export type RoleWithPermissions = Prisma.RoleGetPayload<{ select: typeof ROLE_SELECT }>;

function toDto(role: RoleWithPermissions): Record<string, unknown> {
  const { permissions, ...rest } = role;
  return {
    ...rest,
    permissions: permissions.map((p) => p.permission),
  };
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async list(query: RoleQueryDto): Promise<Paginated<RoleWithPermissions>> {
    const where: Prisma.RoleWhereInput = query.search
      ? {
          OR: [
            { code: { contains: query.search, mode: 'insensitive' } },
            { nameFa: { contains: query.search } },
            { nameEn: { contains: query.search, mode: 'insensitive' } },
          ],
        }
      : {};

    const [items, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        select: ROLE_SELECT,
        orderBy: { code: 'asc' },
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.role.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  async getById(id: string): Promise<RoleWithPermissions> {
    const role = await this.prisma.role.findUnique({ where: { id }, select: ROLE_SELECT });
    if (!role) throw new NotFoundError('Role not found', { id });
    return role;
  }

  async create(
    dto: CreateRoleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<RoleWithPermissions> {
    const existing = await this.prisma.role.findUnique({ where: { code: dto.code } });
    if (existing) throw new ConflictError('Role code already exists', { code: dto.code });

    const role = await this.prisma.role.create({
      data: {
        code: dto.code,
        nameFa: dto.nameFa,
        nameEn: dto.nameEn,
        isSystem: dto.isSystem ?? false,
      },
      select: ROLE_SELECT,
    });
    await this.auditService.record({
      entityType: 'role',
      entityId: role.id,
      action: AuditAction.CREATE,
      actor,
      newValues: toDto(role),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return role;
  }

  async update(
    id: string,
    dto: UpdateRoleDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<RoleWithPermissions> {
    const existing = await this.prisma.role.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Role not found', { id });

    const role = await this.prisma.role.update({
      where: { id },
      data: { nameFa: dto.nameFa, nameEn: dto.nameEn },
      select: ROLE_SELECT,
    });
    await this.auditService.record({
      entityType: 'role',
      entityId: id,
      action: AuditAction.UPDATE,
      actor,
      oldValues: { nameFa: existing.nameFa, nameEn: existing.nameEn },
      newValues: { nameFa: role.nameFa, nameEn: role.nameEn },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return role;
  }

  async remove(id: string, actor: { id: string; username: string }, ctx: RequestContext): Promise<void> {
    const existing = await this.prisma.role.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Role not found', { id });
    if (existing.isSystem) {
      throw new ForbiddenError('System roles cannot be deleted', { code: existing.code });
    }
    const inUse = await this.prisma.userRole.count({ where: { roleId: id } });
    if (inUse > 0) {
      throw new ConflictError('Role is assigned to users and cannot be deleted', { assignedTo: inUse });
    }
    await this.prisma.role.delete({ where: { id } });
    await this.auditService.record({
      entityType: 'role',
      entityId: id,
      action: AuditAction.DELETE,
      actor,
      oldValues: toDto({ ...existing, permissions: [] }),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
  }

  async setPermissions(
    id: string,
    dto: SetRolePermissionsDto,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<RoleWithPermissions> {
    const existing = await this.prisma.role.findUnique({
      where: { id },
      select: ROLE_SELECT,
    });
    if (!existing) throw new NotFoundError('Role not found', { id });

    const uniqueIds = [...new Set(dto.permissionIds)];
    const count = await this.prisma.permission.count({ where: { id: { in: uniqueIds } } });
    if (count !== uniqueIds.length) {
      throw new ValidationError('One or more permission ids do not exist', {
        permissionIds: uniqueIds,
      });
    }

    const oldCodes = existing.permissions.map((p) => p.permission.code).sort();
    const newCodes = (await this.prisma.permission.findMany({
      where: { id: { in: uniqueIds } },
      select: { code: true },
    }))
      .map((p) => p.code)
      .sort();

    if (oldCodes.join(',') !== newCodes.join(',')) {
      await this.prisma.$transaction([
        this.prisma.rolePermission.deleteMany({ where: { roleId: id } }),
        this.prisma.rolePermission.createMany({
          data: uniqueIds.map((permissionId) => ({ roleId: id, permissionId })),
        }),
      ]);
      await this.auditService.record({
        entityType: 'role',
        entityId: id,
        action: AuditAction.PERMISSIONS_CHANGED,
        actor,
        oldValues: { permissions: oldCodes },
        newValues: { permissions: newCodes },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    return this.getById(id);
  }
}
