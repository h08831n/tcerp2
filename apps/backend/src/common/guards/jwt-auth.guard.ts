import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { Request } from 'express';
import { AppConfig, CONFIG } from '../../config/configuration';
import { Inject } from '@nestjs/common';
import { UnauthorizedError } from '../errors';
import { RequestUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

export type AuthenticatedRequest = Request & { user?: RequestUser };

/**
 * Verifies the access JWT from the `Authorization: Bearer` header OR the
 * `access_token` HttpOnly cookie and attaches `req.user = {id, username}`.
 * Routes decorated with @Public() are skipped.
 *
 * R6-S1 (owner-approved policy): EVERY non-public request re-validates the
 * user's status from the database — a DISABLED/LOCKED user loses access
 * from the FIRST subsequent request, even while a previously-issued access
 * token is still signature-valid. The check rides on a single lightweight
 * query per request (this is the central auth boundary — no duplicate
 * status checks in downstream guards/services).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedError('Missing access token');
    }

    let payload: { sub?: string; username?: string };
    try {
      payload = jwt.verify(token, this.config.JWT_SECRET) as typeof payload;
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }
    if (!payload.sub) {
      throw new UnauthorizedError('Invalid access token payload');
    }

    // R6-S1: re-validate user status on EVERY non-public request.
    const dbUser = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { status: true, tokenVersion: true },
    });
    if (!dbUser || dbUser.status !== 'ACTIVE') {
      throw new UnauthorizedError('Account is disabled or does not exist');
    }
    // Access-token revocation: a token from BEFORE the latest password reset
    // carries an older generation (missing ver = generation 0) and is dead.
    const payloadAny = payload as Record<string, unknown>;
    const tokenVer = typeof payloadAny['ver'] === 'number' ? payloadAny['ver'] : 0;
    if (tokenVer !== dbUser.tokenVersion) {
      throw new UnauthorizedError('Access token revoked; sign in again');
    }

    request.user = { id: payload.sub, username: payload.username ?? '' };
    return true;
  }

  private extractToken(request: AuthenticatedRequest): string | undefined {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      return header.slice('Bearer '.length).trim() || undefined;
    }
    const cookies = request.cookies as Record<string, string> | undefined;
    return cookies?.['access_token'];
  }
}
