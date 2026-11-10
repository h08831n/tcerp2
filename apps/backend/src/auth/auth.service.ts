import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { User } from '@prisma/client';
import { AppConfig, CONFIG } from '../config/configuration';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../permissions/permissions.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { BCRYPT_ROUNDS } from '../common/constants';
import { normalizeIranMobile } from '../common/utils/phone';
import { CompanyContextService } from '../companies/company-context.service';
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../common/errors';
import { computeLockout, isLocked } from './lockout';

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export interface UserProfile {
  id: string;
  username: string;
  avatarUrl?: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  mobile: string | null;
  status: string;
  language: string;
  timezone: string;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: UserProfile;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionsService: PermissionsService,
    private readonly auditService: AuditService,
    private readonly companyContext: CompanyContextService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async login(
    identifier: string,
    password: string,
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const now = new Date();
    const user = await this.prisma.user.findFirst({
      where: {
        OR: [{ username: identifier }, { email: identifier.toLowerCase() }],
      },
    });

    const fail = async (detail?: Record<string, unknown>): Promise<never> => {
      await this.auditService.record({
        entityType: 'auth',
        entityId: user?.id ?? identifier,
        action: AuditAction.LOGIN_FAILED,
        actor: user ? { id: user.id, username: user.username } : undefined,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        reason: detail ? JSON.stringify(detail) : undefined,
      });
      throw new UnauthorizedError('Invalid credentials');
    };

    if (!user) return fail();

    if (user.status === 'DISABLED') {
      throw new ForbiddenError('Account is disabled');
    }
    // Administrative lock (UserStatus.LOCKED) — independent of lockout window.
    if (user.status === 'LOCKED') {
      throw new ForbiddenError('Account is locked', {
        lockedUntil: user.lockedUntil,
      });
    }
    // Failed-login lockout window.
    if (isLocked(user, now)) {
      throw new ForbiddenError('Account is temporarily locked', {
        lockedUntil: user.lockedUntil,
      });
    }

    const passwordOk = await bcrypt.compare(password, user.passwordHash);
    if (!passwordOk) {
      const failedLoginCount = user.failedLoginCount + 1;
      const lockedUntil = computeLockout(
        failedLoginCount,
        this.config.LOGIN_MAX_ATTEMPTS,
        this.config.LOGIN_LOCK_MINUTES,
        now,
      );
      await this.prisma.user.update({
        where: { id: user.id },
        data: { failedLoginCount, lockedUntil },
      });
      return fail({ failedLoginCount, locked: !!lockedUntil });
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: now },
    });

    const accessToken = this.signAccessToken(user);
    const refreshToken = await this.createRefreshToken(user.id, ctx);
    await this.auditService.record({
      entityType: 'auth',
      entityId: user.id,
      action: AuditAction.LOGIN,
      actor: { id: user.id, username: user.username },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });

    return { accessToken, refreshToken, user: this.toProfile(user) };
  }

  /**
   * Rotate a refresh token. Reuse of an already-revoked token is treated as
   * token theft: every refresh token of the user is revoked.
   */
  async refresh(rawToken: string | undefined, ctx: RequestContext): Promise<LoginResult> {
    if (!rawToken) {
      throw new UnauthorizedError('Missing refresh token');
    }
    const now = new Date();
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: sha256(rawToken) },
    });
    if (!stored) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: stored.userId, revokedAt: null },
        data: { revokedAt: now },
      });
      await this.auditService.record({
        entityType: 'auth',
        entityId: stored.userId,
        action: AuditAction.REFRESH_TOKEN_REUSE,
        reason: 'Revoked refresh token was presented again; all sessions revoked',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedError('Refresh token reuse detected; all sessions revoked');
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      throw new UnauthorizedError('Refresh token expired');
    }

    const user = await this.prisma.user.findUnique({ where: { id: stored.userId } });
    if (!user || user.status === 'DISABLED') {
      throw new ForbiddenError('Account is disabled');
    }

    const newRaw = randomBytes(48).toString('hex');
    await this.prisma.$transaction(async (trx) => {
      const created = await trx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash: sha256(newRaw),
          expiresAt: new Date(now.getTime() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        },
      });
      await trx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: now, replacedByTokenId: created.id },
      });
    });

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null },
    });

    return {
      accessToken: this.signAccessToken(user),
      refreshToken: newRaw,
      user: this.toProfile(user),
    };
  }

  async logout(rawToken: string | undefined, ctx: RequestContext): Promise<void> {
    if (rawToken) {
      const stored = await this.prisma.refreshToken.findUnique({
        where: { tokenHash: sha256(rawToken) },
      });
      if (stored && !stored.revokedAt) {
        await this.prisma.refreshToken.update({
          where: { id: stored.id },
          data: { revokedAt: new Date() },
        });
        await this.auditService.record({
          entityType: 'auth',
          entityId: stored.userId,
          action: AuditAction.LOGOUT,
          actor: { id: stored.userId },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
      }
    }
  }

  /**
   * Mini-Gate: roles are company-scoped. `permissions` are the effective
   * permissions for the user's default company (null → platform context);
   * `rolesPerCompany` groups the raw role assignments per company.
   */
  async me(userId: string): Promise<
    UserProfile & {
      permissions: string[];
      companies: { id: string; nameFa: string; isDefault: boolean }[];
      defaultCompanyId: string | null;
      rolesPerCompany: { companyId: string; roles: { code: string; nameFa: string; nameEn: string }[] }[];
    }
  > {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { companyRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundError('User not found');

    const memberships = await this.companyContext.memberships(userId);
    const permissions = await this.permissionsService.getEffectivePermissions(
      userId,
      user.defaultCompanyId,
    );

    const rolesPerCompany = new Map<
      string,
      { code: string; nameFa: string; nameEn: string }[]
    >();
    for (const assignment of user.companyRoles) {
      const roles = rolesPerCompany.get(assignment.companyId) ?? [];
      roles.push({
        code: assignment.role.code,
        nameFa: assignment.role.nameFa,
        nameEn: assignment.role.nameEn,
      });
      rolesPerCompany.set(assignment.companyId, roles);
    }

    return {
      ...this.toProfile(user),
      permissions: [...permissions].sort(),
      companies: memberships.map((c) => ({
        id: c.companyId,
        nameFa: c.nameFa,
        isDefault: c.isDefault,
      })),
      defaultCompanyId: user.defaultCompanyId,
      rolesPerCompany: [...rolesPerCompany.entries()].map(([companyId, roles]) => ({
        companyId,
        roles,
      })),
    };
  }

  private signAccessToken(user: User): string {
    return jwt.sign({ sub: user.id, username: user.username }, this.config.JWT_SECRET, {
      expiresIn: this.config.ACCESS_TOKEN_TTL,
    } as jwt.SignOptions);
  }

  private async createRefreshToken(userId: string, ctx: RequestContext): Promise<string> {
    const raw = randomBytes(48).toString('hex');
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + this.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      },
    });
    return raw;
  }

  private toProfile(user: User): UserProfile {
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      mobile: user.mobile,
      avatarUrl: user.avatarUrl,
      status: user.status,
      language: user.language,
      timezone: user.timezone,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
    };
  }

  // ── CORE-004: self-service profile & password ────────────────────────────

  /**
   * Self-profile update: ONLY the whitelisted self-service fields. Status,
   * roles, company memberships and permissions are structurally unreachable
   * here — privilege escalation by shape is impossible (no such columns in
   * the update payload).
   */
  async updateOwnProfile(
    userId: string,
    dto: {
      firstName?: string;
      lastName?: string;
      email?: string;
      mobile?: string;
      language?: string;
      timezone?: string;
      avatarUrl?: string;
    },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User not found');

    const data: Record<string, unknown> = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName.trim() || null;
    if (dto.lastName !== undefined) data.lastName = dto.lastName.trim() || null;
    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase() || null;
      if (email && email !== user.email) {
        const taken = await this.prisma.user.findFirst({
          where: { email, id: { not: userId } },
          select: { id: true },
        });
        if (taken) throw new ValidationError('Email already exists');
      }
      data.email = email;
    }
    if (dto.mobile !== undefined) {
      data.mobile = dto.mobile === '' ? null : normalizeIranMobile(dto.mobile);
    }
    if (dto.language !== undefined) data.language = dto.language;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl.trim() || null;

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data });
      await this.auditService.recordTx(tx, {
        entityType: 'user',
        entityId: userId,
        action: AuditAction.UPDATE,
        actor,
        oldValues: {
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          mobile: user.mobile,
          language: user.language,
          timezone: user.timezone,
          avatarUrl: user.avatarUrl,
        },
        newValues: data,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }

  /**
   * CORE-004 — self-service password change: requires the CURRENT password
   * (re-authentication), applies the same hash policy as user creation, and
   * audits WITHOUT ever storing the raw password. The current session stays
   * alive; other refresh tokens are revoked (other devices must re-login).
   */
  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
    currentRefreshHash?: string,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError('User not found');

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) {
      throw new ValidationError('CURRENT_PASSWORD_INCORRECT');
    }
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new ValidationError('NEW_PASSWORD_SAME_AS_CURRENT');
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash, mustChangePassword: false },
      });
      // SECURITY: every OTHER active device is force-logged-out. The CURRENT
      // browser session survives (the caller's access token + refresh cookie
      // are untouched here) so the flow completes without re-login.
      await tx.refreshToken.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentRefreshHash ? { tokenHash: { not: currentRefreshHash } } : {}),
        },
        data: { revokedAt: new Date() },
      });
      await this.auditService.recordTx(tx, {
        entityType: 'user',
        entityId: userId,
        action: 'PASSWORD_CHANGED',
        actor,
        oldValues: undefined, // NEVER store password hashes in the audit
        newValues: { passwordChanged: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    });
  }
}
