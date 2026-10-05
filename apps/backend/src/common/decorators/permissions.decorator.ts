import { SetMetadata } from '@nestjs/common';

export const PERMISSIONS_KEY = 'tcerp:permissions';

/**
 * Declares the permission codes required by a route (any-of semantics:
 * every listed code must be present in the user's effective permission set).
 * Enforced by PermissionsGuard.
 */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(PERMISSIONS_KEY, codes);
