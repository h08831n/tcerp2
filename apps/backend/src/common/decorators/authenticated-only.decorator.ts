import { SetMetadata } from '@nestjs/common';

/**
 * FINAL-REVIEW marker: this route requires authentication + company scoping
 * ONLY — no module permission gate (intentional, documented at the route).
 * The hardening sweep (src/final-review/hardening.spec.ts) accepts it as an
 * explicit decision; an UNGUARDED route without this marker is a failure.
 */
export const AUTHENTICATED_ONLY_KEY = 'tcerp:authenticated-only';

export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);
