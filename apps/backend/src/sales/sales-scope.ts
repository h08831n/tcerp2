import { Prisma } from '@prisma/client';
import { ForbiddenError } from '../common/errors';

/**
 * Sales record scope (Phase 4) — the party-scope OWN/TEAM/ALL precedent
 * generalized to sales documents, keyed on `salespersonUserId`:
 *   - `sales.scope.all` (or `sales.view_all`) → ALL
 *   - `sales.scope.team`                      → TEAM (the user's teams' salespeople)
 *   - neither                                 → OWN (own documents only)
 */
export type SalesScope = 'OWN' | 'TEAM' | 'ALL';

export const SALES_SCOPE_PERMISSIONS = {
  all: 'sales.scope.all',
  team: 'sales.scope.team',
  viewAll: 'sales.view_all',
} as const;

/** Pure permission → scope resolution (unit-testable without a DB). */
export function resolveSalesScope(permissions: Iterable<string>): SalesScope {
  const set = permissions instanceof Set ? permissions : new Set(permissions);
  if (set.has(SALES_SCOPE_PERMISSIONS.all) || set.has(SALES_SCOPE_PERMISSIONS.viewAll)) return 'ALL';
  if (set.has(SALES_SCOPE_PERMISSIONS.team)) return 'TEAM';
  return 'OWN';
}

export interface ActorScope {
  userId: string;
  scope: SalesScope;
}

/** SQL WHERE fragment restricting a sales-document query to the scope. */
export function salesScopeWhere(
  scope: SalesScope,
  userId: string,
  teamUserIds: string[],
): Prisma.SalesDocumentWhereInput {
  if (scope === 'ALL') return {};
  if (scope === 'TEAM') {
    return { salespersonUserId: { in: [...new Set([userId, ...teamUserIds])] } };
  }
  return { salespersonUserId: userId };
}

/** ForbiddenError unless the document is visible under the record scope. */
export function assertSalesInScope(
  scope: SalesScope,
  userId: string,
  teamUserIds: string[],
  doc: { id: string; salespersonUserId: string },
): void {
  if (scope === 'ALL') return;
  if (doc.salespersonUserId === userId) return;
  if (scope === 'TEAM' && teamUserIds.includes(doc.salespersonUserId)) return;
  throw new ForbiddenError('SALES_DOCUMENT_OUT_OF_SCOPE', { salesDocumentId: doc.id });
}
