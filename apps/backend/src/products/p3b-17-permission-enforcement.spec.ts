import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from '../common/guards/permissions.guard';
import { ForbiddenError, UnauthorizedError } from '../common/errors';

/**
 * p3b-17 — permission-enforcement: a route declaring @RequirePermissions
 * rejects a caller whose effective permission set lacks the code with
 * ForbiddenError (guard unit-test pattern, no HTTP server).
 */
describe('p3b-17 permission-enforcement', () => {
  function makeContext(user?: { id: string }): { context: ExecutionContext; headers: Record<string, string> } {
    const headers: Record<string, string> = {};
    const request = { user, headers };
    const context = {
      getHandler: () => () => undefined,
      getClass: () => class C {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
    return { context, headers };
  }

  function makeGuard(
    required: string[] | undefined,
    effective: Set<string> | Promise<Set<string>>,
  ) {
    const reflector = {
      getAllAndOverride: jest.fn(() => required),
    } as unknown as Reflector;
    const permissionsService = {
      getEffectivePermissions: jest.fn(async () => effective),
    };
    const companyContext = {
      resolveLenientCompanyId: jest.fn(async () => 'company-1'),
    };
    return new PermissionsGuard(
      reflector,
      permissionsService as never,
      companyContext as never,
    );
  }

  it('a user WITHOUT products.create is rejected with ForbiddenError (missing listed)', async () => {
    const { context } = makeContext({ id: 'u1' });
    const guard = makeGuard(['products.create'], new Set(['products.view']));
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenError);
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      statusCode: 403,
      details: { missing: ['products.create'] },
    });
  });

  it('a user WITH the required permission passes', async () => {
    const { context } = makeContext({ id: 'u1' });
    const guard = makeGuard(
      ['products.view'],
      new Set(['products.view', 'products.create']),
    );
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('every listed permission must be present (all-of semantics)', async () => {
    const { context } = makeContext({ id: 'u1' });
    const guard = makeGuard(
      ['products.view', 'products.variants.manage'],
      new Set(['products.view']),
    );
    await expect(guard.canActivate(context)).rejects.toMatchObject({
      details: { missing: ['products.variants.manage'] },
    });
  });

  it('routes without metadata stay open to the guard (guard returns true)', async () => {
    const { context } = makeContext({ id: 'u1' });
    const guard = makeGuard(undefined, new Set());
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('an unauthenticated request is UnauthorizedError, not ForbiddenError', async () => {
    const { context } = makeContext(undefined);
    const guard = makeGuard(['products.view'], new Set());
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedError);
  });
});
