import { SalesDocumentsService } from './sales-documents.service';
import { NotFoundError } from '../common/errors';
import { TimelineService } from '../parties/timeline.service';

/**
 * p4-31 company-isolation: a sales document of company A is invisible
 * (404 semantics) in a company-B context; every list WHERE carries the
 * companyId filter; out-of-scope documents are 403 (never leak data).
 */
describe('p4-31 company-isolation', () => {
  const COMPANY_A = '00000000-0000-4000-8000-000000000001';
  const COMPANY_B = '00000000-0000-4000-8000-000000000002';

  function makeService(docRow: Record<string, unknown> | null) {
    const prisma: Record<string, unknown> = {
      salesDocument: {
        findFirst: jest.fn(async (args: unknown) => {
          const a = args as { where: { id: string; companyId: string } };
          if (docRow && a.where.companyId === COMPANY_A && a.where.id === docRow.id) return docRow;
          return null;
        }),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      salesLine: { groupBy: jest.fn(async () => []), findMany: jest.fn(async () => []) },
      team: { findMany: jest.fn(async () => []) },
      teamMember: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
    };
    const service = new SalesDocumentsService(
      prisma as never,
      {} as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      new TimelineService(prisma as never),
      {} as never,
    );
    return { service, prisma };
  }

  const docOfA = {
    id: 'doc-a1',
    companyId: COMPANY_A,
    documentNumber: 'SD-1405-90001',
    status: 'QUOTATION',
    salespersonUserId: 'user-a1',
  };

  it('getById: company B gets NotFoundError (404) for a document of company A', async () => {
    const { service } = makeService(docOfA);
    await expect(
      service.getById(COMPANY_B, { userId: 'u2', scope: 'ALL' }, 'doc-a1'),
    ).rejects.toMatchObject({ statusCode: 404, message: 'Sales document not found' });
  });

  it('getById: inside company A the document is returned (scope ALL)', async () => {
    const { service } = makeService(docOfA);
    await expect(
      service.getById(COMPANY_A, { userId: 'user-a1', scope: 'ALL' }, 'doc-a1'),
    ).resolves.toBeTruthy();
  });

  it('getById: out-of-scope (OWN, someone else’s document) → 403', async () => {
    const { service } = makeService(docOfA);
    await expect(
      service.getById(COMPANY_A, { userId: 'user-other', scope: 'OWN' }, 'doc-a1'),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('transitions never cross companies', async () => {
    const { service } = makeService(docOfA);
    await expect(
      service.send(COMPANY_B, { userId: 'u2', scope: 'ALL' }, 'doc-a1', { id: 'u2', username: 'b' }, {}),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the list query is always company-bound', async () => {
    const { service, prisma } = makeService(null);
    await service.list(COMPANY_B, { userId: 'u2', scope: 'ALL' }, { page: 1, pageSize: 20, sortDir: 'desc', skip: 0, take: 20 });
    const findMany = prisma.salesDocument as { findMany: jest.Mock };
    const args = (findMany.findMany.mock.calls[0] as unknown[])[0] as { where: { companyId: string } };
    expect(args.where.companyId).toBe(COMPANY_B);
  });

  it('NotFoundError is the isolation envelope', () => {
    expect(new NotFoundError('Sales document not found').statusCode).toBe(404);
  });
});
