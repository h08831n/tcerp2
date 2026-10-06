import { CategoriesService } from './categories.service';
import { TemplatesService } from './templates.service';

/**
 * p3b-19 — archive-filtering: list endpoints exclude archived rows by
 * default; `?active=false` shows only archived; `?active=any` shows both.
 * Archive = PATCH active:false (categories) / DELETE (templates, soft).
 */
describe('p3b-19 archive-filtering', () => {
  const COMPANY = 'company-1';

  function makePrisma() {
    return {
      productCategory: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        findUnique: jest.fn(async () => null),
        update: jest.fn(),
        delete: jest.fn(),
      },
      productTemplate: {
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
        findUnique: jest.fn(async () => null),
      },
      productVariant: { groupBy: jest.fn(async () => []) },
      $transaction: jest.fn(),
    };
  }

  describe('categories', () => {
    it('default: only active rows (active: true in the where clause)', async () => {
      const prisma = makePrisma();
      const service = new CategoriesService(prisma as never, { recordTx: jest.fn() } as never);
      await service.list(COMPANY, { page: 1, pageSize: 20 } as never);
      const where = (prisma.productCategory.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ companyId: COMPANY, active: true });
    });

    it('?active=false: only archived rows', async () => {
      const prisma = makePrisma();
      const service = new CategoriesService(prisma as never, { recordTx: jest.fn() } as never);
      await service.list(COMPANY, { page: 1, pageSize: 20, active: 'false' } as never);
      const where = (prisma.productCategory.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.active).toBe(false);
    });

    it('?active=any: no active filter at all', async () => {
      const prisma = makePrisma();
      const service = new CategoriesService(prisma as never, { recordTx: jest.fn() } as never);
      await service.list(COMPANY, { page: 1, pageSize: 20, active: 'any' } as never);
      const where = (prisma.productCategory.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.active).toBeUndefined();
    });

    it('PATCH active:false archives softly (audited, row kept)', async () => {
      const prisma = makePrisma();
      (prisma.productCategory.findUnique as jest.Mock).mockResolvedValue({
        id: 'cat-1',
        companyId: COMPANY,
        nameFa: 'دسته',
        active: true,
      });
      const audit = { record: jest.fn(), recordTx: jest.fn() };
      const service = new CategoriesService(prisma as never, audit as never);
      (prisma.productCategory as { update?: unknown }).update = jest.fn(async () => ({
        id: 'cat-1',
        active: false,
      }));
      (prisma as { $transaction: unknown }).$transaction = jest.fn(
        async (fn: (t: unknown) => unknown) =>
          fn({
            productCategory: { update: (prisma.productCategory as { update: unknown }).update },
          }),
      );
      await service.update(COMPANY, 'cat-1', { active: false }, { id: 'u1', username: 'a' }, {});
      expect((prisma.productCategory as { update: jest.Mock }).update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'cat-1' }, data: { active: false } }),
      );
      expect(audit.recordTx).toHaveBeenCalled();
    });
  });

  describe('templates', () => {
    it('default: only active templates', async () => {
      const prisma = makePrisma();
      const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
      await service.list(COMPANY, { page: 1, pageSize: 20 } as never);
      const where = (prisma.productTemplate.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where).toMatchObject({ companyId: COMPANY, active: true });
    });

    it('?active=false shows only archived templates', async () => {
      const prisma = makePrisma();
      const service = new TemplatesService(prisma as never, { recordTx: jest.fn() } as never);
      await service.list(COMPANY, { page: 1, pageSize: 20, active: 'false' } as never);
      const where = (prisma.productTemplate.findMany as jest.Mock).mock.calls[0][0].where;
      expect(where.active).toBe(false);
    });
  });
});
