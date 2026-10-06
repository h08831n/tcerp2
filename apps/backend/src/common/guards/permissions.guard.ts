import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  PERMISSIONS_KEY,
  RequirePermissions,
} from '../decorators/permissions.decorator';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { AuthenticatedRequest } from './jwt-auth.guard';
import { PermissionsService } from '../../permissions/permissions.service';
import { CompanyContextService } from '../../companies/company-context.service';

/**
 * Backend permission enforcement (REQUIREMENTS §2.5: permissions must be
 * enforced server-side, UI hiding is cosmetic only).
 *
 * Reads @RequirePermissions(...) metadata; if none present the route is
 * allowed. Resolves the user's effective permissions through
 * PermissionsService, scoped to the request's company (Mini-Gate):
 *
 * Company resolution is LENIENT (never throws):
 *   1. `x-company-id` header when the user is a member of that company;
 *   2. otherwise the user's `defaultCompanyId` (when still a member);
 *   3. otherwise null.
 *
 * With no company resolvable only platform-wide (companyId IS NULL)
 * overrides apply and no company-scoped role permissions are granted —
 * platform-level routes must therefore grant their permissions through
 * roles in the user's companies or platform-wide overrides.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsService: PermissionsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.user) {
      throw new UnauthorizedError('Authentication required');
    }

    const companyId = await this.companyContext.resolveLenientCompanyId(
      request.user,
      request.headers,
    );
    const effective = await this.permissionsService.getEffectivePermissions(
      request.user.id,
      companyId,
    );
    const missing = required.filter((code) => !effective.has(code));
    if (missing.length > 0) {
      throw new ForbiddenError('Missing required permissions', { missing });
    }
    return true;
  }
}

// Re-exported for convenience of module authors.
export { RequirePermissions };
