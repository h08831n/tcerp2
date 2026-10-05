import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface RequestUser {
  id: string;
  username: string;
}

/**
 * Parameter decorator exposing the authenticated user attached by
 * JwtAuthGuard. `@CurrentUser('id')` yields just the id.
 */
export const CurrentUser = createParamDecorator(
  (data: keyof RequestUser | undefined, ctx: ExecutionContext): RequestUser | string | undefined => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    if (!request.user) return undefined;
    return data ? request.user[data] : request.user;
  },
);
