import { resolveSalesScope, assertSalesInScope, salesScopeWhere } from './sales-scope';
import { SalesDocumentsService } from './sales-documents.service';
import { ForbiddenError } from '../common/errors';

/**
 * p4-30 own-team-all-sales-scope: sales document scope is resolved from
 * permissions (`sales.scope.all` / `sales.view_all` → ALL,
 * `sales.scope.team` → TEAM, else OWN) and enforced on list + get + write
 * (salespersonUserId-based; the party-scope OWN/TEAM/ALL precedent).
 */
describe('p4-30 own-team-all sales scope', () => {
  const ME = 'user-me';
  const TEAMMATE = 'user-teammate';
  const STRANGER = 'user-stranger';
  const teamUserIds = [TEAMMATE];

  it('permission → scope resolution', () => {
    expect(resolveSalesScope([])).toBe('OWN');
    expect(resolveSalesScope(['sales.view'])).toBe('OWN');
    expect(resolveSalesScope(['sales.scope.team'])).toBe('TEAM');
    expect(resolveSalesScope(['sales.scope.all'])).toBe('ALL');
    // sales.view_all also grants ALL visibility.
    expect(resolveSalesScope(['sales.view_all'])).toBe('ALL');
    expect(resolveSalesScope(['sales.scope.team', 'sales.scope.all'])).toBe('ALL');
  });

  it('list WHERE restricts by salespersonUserId for OWN/TEAM, unrestricted for ALL', () => {
    expect(salesScopeWhere('OWN', ME, [])).toEqual({ salespersonUserId: ME });
    expect(salesScopeWhere('TEAM', ME, teamUserIds)).toEqual({ salespersonUserId: { in: [ME, TEAMMATE] } });
    expect(salesScopeWhere('ALL', ME, [])).toEqual({});
  });

  it('in-scope reads pass; out-of-scope reads → ForbiddenError', () => {
    expect(() =>
      assertSalesInScope('OWN', ME, [], { id: 'd1', salespersonUserId: ME }),
    ).not.toThrow();
    expect(() =>
      assertSalesInScope('TEAM', ME, teamUserIds, { id: 'd1', salespersonUserId: TEAMMATE }),
    ).not.toThrow();
    expect(() =>
      assertSalesInScope('TEAM', ME, teamUserIds, { id: 'd1', salespersonUserId: STRANGER }),
    ).toThrow(ForbiddenError);
    expect(() =>
      assertSalesInScope('ALL', ME, [], { id: 'd1', salespersonUserId: STRANGER }),
    ).not.toThrow();
  });

  it('the service list WHERE carries the scope fragment (OWN)', async () => {
    const findMany = jest.fn(async () => []);
    const count = jest.fn(async () => 0);
    const prisma = {
      salesDocument: { findMany, count },
      salesLine: { groupBy: jest.fn(async () => []) },
      team: { findMany: jest.fn(async () => []) },
      teamMember: { findMany: jest.fn(async () => []) },
    };
    const service = new SalesDocumentsService(
      prisma as never,
      {} as never,
      { recordTx: jest.fn(), record: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await service.list(
      'company-1',
      { userId: ME, scope: 'OWN' },
      { page: 1, pageSize: 20, sortDir: 'desc', skip: 0, take: 20 },
    );
    const args = (findMany.mock.calls[0] as unknown[])[0] as { where: { companyId: string; salespersonUserId?: string; AND: { salespersonUserId: string }[] } };
    expect(args.where.companyId).toBe('company-1');
    // Scope rides in the AND fragment — a hard ceiling over any filter.
    expect(args.where.AND[0].salespersonUserId).toBe(ME);
    expect(args.where.salespersonUserId).toBeUndefined();
  });

  it('the service list WHERE includes team members for TEAM scope', async () => {
    const findMany = jest.fn(async () => []);
    const prisma = {
      salesDocument: { findMany, count: jest.fn(async () => 0) },
      salesLine: { groupBy: jest.fn(async () => []) },
      team: {
        findMany: jest.fn(async () => [{ id: 't1' }]),
      },
      teamMember: { findMany: jest.fn(async () => [{ userId: TEAMMATE }]) },
    };
    const service = new SalesDocumentsService(
      prisma as never,
      {} as never,
      { recordTx: jest.fn(), record: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    await service.list(
      'company-1',
      { userId: ME, scope: 'TEAM' },
      { page: 1, pageSize: 20, sortDir: 'desc', skip: 0, take: 20 },
    );
    const args = (findMany.mock.calls[0] as unknown[])[0] as { where: { AND: { salespersonUserId: { in: string[] } }[] } };
    expect(args.where.AND[0].salespersonUserId.in).toEqual(expect.arrayContaining([ME, TEAMMATE]));
  });
});
