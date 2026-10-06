import { Prisma } from '@prisma/client';
import { ForbiddenError } from '../common/errors';

/**
 * Record scope for CRM parties (REQUIREMENTS §60, backend-enforced).
 *
 * Encoded as a permission-scope convention:
 *   - `parties.scope.all`  → ALL  (every party in the company)
 *   - `parties.scope.team` → TEAM (parties owned by the user's team members)
 *   - neither              → OWN  (only the user's own parties)
 */
export type RecordScope = 'OWN' | 'TEAM' | 'ALL';

export const SCOPE_PERMISSIONS = {
  all: 'parties.scope.all',
  team: 'parties.scope.team',
} as const;

/** Pure permission → scope resolution (unit-testable without a DB). */
export function resolveRecordScope(permissions: Iterable<string>): RecordScope {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  if (set.has(SCOPE_PERMISSIONS.all)) return 'ALL';
  if (set.has(SCOPE_PERMISSIONS.team)) return 'TEAM';
  return 'OWN';
}

/** SQL WHERE fragment restricting a party query to the record scope. */
export function scopeWhere(
  scope: RecordScope,
  userId: string,
  teamUserIds: string[],
): Prisma.PartyWhereInput {
  if (scope === 'ALL') return {};
  if (scope === 'TEAM') {
    return { ownerUserId: { in: [...new Set([userId, ...teamUserIds])] } };
  }
  return { ownerUserId: userId };
}

/** ForbiddenError unless `party` is visible under the record scope. */
export function assertInScope(
  scope: RecordScope,
  userId: string,
  teamUserIds: string[],
  party: { id: string; ownerUserId: string | null },
): void {
  if (scope === 'ALL') return;
  if (party.ownerUserId && party.ownerUserId === userId) return;
  if (
    scope === 'TEAM' &&
    party.ownerUserId &&
    (teamUserIds.includes(party.ownerUserId) || party.ownerUserId === userId)
  ) {
    return;
  }
  throw new ForbiddenError('Party is outside your record scope', { partyId: party.id });
}
