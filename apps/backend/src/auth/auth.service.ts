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
import {
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
} from '../common/errors';
import { computeLockout, isLocked } from './lockout';

export interface RequestContext {
  ip?: string;
  userAgent?: string;
}

export interface UserProfile {
  id: string;
  username: string;
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

  async me(userId: string): Promise<UserProfile & { roles: { code: string; nameFa: string; nameEn: string }[]; permissions: string[] }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundError('User not found');
    const permissions = await this.permissionsService.getEffectivePermissions(userId);
    return {
      ...this.toProfile(user),
      roles: user.roles.map(({ role }) => ({
        code: role.code,
        nameFa: role.nameFa,
        nameEn: role.nameEn,
      })),
      permissions: [...permissions].sort(),
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
      status: user.status,
      language: user.language,
      timezone: user.timezone,
      mustChangePassword: user.mustChangePassword,
      lastLoginAt: user.lastLoginAt,
    };
  }
}
