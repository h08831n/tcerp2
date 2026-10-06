import { SalesDocumentsService } from './sales-documents.service';

/**
 * p4-34 grid-no-n1: the sales list is a lightweight projection served with
 * EXACTLY 3 queries per page — findMany, count and ONE grouped line count —
 * regardless of how many rows the page holds.
 */
describe('p4-34 grid has no N+1', () => {
  function makePrisma(rowCount: number) {
    const rows = Array.from({ length: rowCount }, (_, i) => ({
      id: `doc-${i}`,
      documentNumber: `SD-1405-00${String(i + 10).padStart(3, '0')}`,
      status: 'QUOTATION',
      documentDate: new Date(),
      expirationDate: new Date(),
      subtotal: '1000',
      discountTotal: '0',
      taxTotal: '0',
      total: '1000',
      version: 1,
      customer: { id: 'c1', nameFa: 'مشتری' },
      salesperson: { id: 'u1', username: 'sales', firstName: null, lastName: null },
    }));
    return {
      salesDocument: {
        findMany: jest.fn(async () => rows),
        count: jest.fn(async () => rowCount),
      },
      salesLine: {
        groupBy: jest.fn(async () => rows.map((r) => ({ salesDocumentId: r.id, _count: { _all: 2 } }))),
      },
      team: { findMany: jest.fn(async () => []) },
      teamMember: { findMany: jest.fn(async () => []) },
    };
  }

  it('a 20-row page runs exactly 3 queries (no per-row line counts)', async () => {
    const prisma = makePrisma(20);
    const service = new SalesDocumentsService(
      prisma as never,
      {} as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      {} as never,
      {} as never,
    );

    const result = await service.list('company-1', { userId: 'u1', scope: 'ALL' }, {
      page: 1,
      pageSize: 20,
      sortDir: 'desc',
      skip: 0,
      take: 20,
    });

    expect(prisma.salesDocument.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.salesDocument.count).toHaveBeenCalledTimes(1);
    expect(prisma.salesLine.groupBy).toHaveBeenCalledTimes(1);
    const groupByArgs = (prisma.salesLine.groupBy.mock.calls[0] as unknown[])[0] as { where: { salesDocumentId: { in: string[] } } };
    expect(Array.isArray(groupByArgs.where.salesDocumentId.in)).toBe(true);

    expect(result.items).toHaveLength(20);
    expect((result.items as { lineCount: number }[]).every((item) => item.lineCount === 2)).toBe(true);
    expect(result.total).toBe(20);
  });

  it('an empty page still caps at the same 3-query shape (no wasted groupBy)', async () => {
    const prisma = makePrisma(0);
    (prisma.salesDocument.findMany as jest.Mock).mockResolvedValue([]);
    const service = new SalesDocumentsService(
      prisma as never,
      {} as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      {} as never,
      {} as never,
    );

    const result = await service.list('company-1', { userId: 'u1', scope: 'OWN' }, {
      page: 1,
      pageSize: 20,
      sortDir: 'desc',
      skip: 0,
      take: 20,
    });

    expect(prisma.salesDocument.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.salesDocument.count).toHaveBeenCalledTimes(1);
    expect(prisma.salesLine.groupBy).not.toHaveBeenCalled(); // ids: [] short-circuit
    expect(result.items).toHaveLength(0);
  });

  it('the projection stays lightweight (grid fields only)', async () => {
    const prisma = makePrisma(3);
    const service = new SalesDocumentsService(
      prisma as never,
      {} as never,
      { record: jest.fn(), recordTx: jest.fn() } as never,
      {} as never,
      {} as never,
    );
    const result = await service.list('company-1', { userId: 'u1', scope: 'ALL' }, {
      page: 1,
      pageSize: 20,
      sortDir: 'desc',
      skip: 0,
      take: 20,
    });
    const item = result.items[0] as Record<string, unknown>;
    for (const key of ['id', 'documentNumber', 'status', 'documentDate', 'expirationDate', 'customer', 'salesperson', 'totals', 'lineCount', 'version']) {
      expect(item).toHaveProperty(key);
    }
    // The findMany select is a projection — no unbounded includes.
    const args = (prisma.salesDocument.findMany as jest.Mock).mock.calls[0][0];
    expect(Object.keys(args.select)).not.toContain('lines');
  });
});
