import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { Request } from 'express';
import { AppConfig, CONFIG } from '../../config/configuration';
import { Inject } from '@nestjs/common';
import { UnauthorizedError } from '../errors';
import { RequestUser } from '../decorators/current-user.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export type AuthenticatedRequest = Request & { user?: RequestUser };

/**
 * Verifies the access JWT from the `Authorization: Bearer` header OR the
 * `access_token` HttpOnly cookie and attaches `req.user = {id, username}`.
 * Routes decorated with @Public() are skipped.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
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
