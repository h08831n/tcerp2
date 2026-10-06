import { CategoriesService, wouldCreateCycle } from './categories.service';

/**
 * p3b-01 — category-hierarchy: a 3-level tree (root → child → grandchild)
 * can be created and looked up; parentId wiring and company scoping hold at
 * every level.
 */
describe('p3b-01 category-hierarchy', () => {
  const COMPANY = 'company-1';

  function makeService(created: Record<string, unknown>[] = []) {
    const trx = {
      productCategory: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: `cat-${created.length + 1}`, version: 1, ...args.data };
          created.push(row);
          return row;
        }),
      },
    };
    const prisma = {
      productCategory: {
        create: jest.fn(),
        findUnique: jest.fn(async (args: { where: { id: string } }) =>
          created.find((c) => (c as { id: string }).id === args.where.id) ?? null,
        ),
        findMany: jest.fn(async () => []),
        count: jest.fn(async () => 0),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new CategoriesService(prisma as never, audit as never);
    return { service, prisma, trx, created, audit };
  }

  it('creates a 3-level tree: root → child → grandchild with parent wiring', async () => {
    const { service, created } = makeService();

    const root = await service.create(
      COMPANY,
      { code: 'ELEC', nameFa: 'الکترونیک', nameEn: 'Electronics' },
      { id: 'u1', username: 'admin' },
      {},
    );
    const child = await service.create(
      COMPANY,
      { code: 'MOBILE', nameFa: 'موبایل', nameEn: 'Mobile', parentId: (root as { id: string }).id },
      { id: 'u1', username: 'admin' },
      {},
    );
    const grandchild = await service.create(
      COMPANY,
      { code: 'SMARTPHONE', nameFa: 'گوشی هوشمند', nameEn: 'Smartphone', parentId: (child as { id: string }).id },
      { id: 'u1', username: 'admin' },
      {},
    );

    expect(created).toHaveLength(3);
    expect(created[0]).toMatchObject({ code: 'ELEC', parentId: undefined });
    expect(created[1]).toMatchObject({ code: 'MOBILE', parentId: root.id });
    expect(created[2]).toMatchObject({ code: 'SMARTPHONE', parentId: child.id });
  });

  it('lookup returns the node with its (active) children for the same company', async () => {
    const { service, created, prisma } = makeService();
    const root = { id: 'cat-root', companyId: COMPANY, code: 'ELEC', nameFa: 'الکترونیک', active: true };
    created.push(root);
    (prisma.productCategory.findUnique as jest.Mock).mockResolvedValueOnce({
      ...root,
      parent: null,
      children: [{ id: 'cat-child', nameFa: 'موبایل', nameEn: 'Mobile', code: 'MOBILE', sortOrder: 0 }],
      _count: { templates: 0 },
    });

    const found = (await service.getById(COMPANY, 'cat-root')) as {
      children: unknown[];
      companyId: string;
    };
    expect(found.companyId).toBe(COMPANY);
    expect(found.children).toHaveLength(1);
    expect(found.children[0]).toMatchObject({ code: 'MOBILE', nameEn: 'Mobile' });
  });

  it('a category of another company is invisible (NotFound)', async () => {
    const { service, prisma } = makeService();
    (prisma.productCategory.findUnique as jest.Mock).mockResolvedValueOnce(null);
    await expect(service.getById(COMPANY, 'cat-foreign')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

/**
 * p3b-02 — category-cycle-prevention: PATCHing a category under itself or
 * under one of its descendants is rejected with ValidationError
 * `CATEGORY_CYCLE` (ancestor walk), at the pure-function level too.
 */
describe('p3b-02 category-cycle-prevention', () => {
  it('pure check: self parent and descendant parent are cycles; ancestor is fine', () => {
    // Tree: c1 ← c2 (c2.parentId = c1), c2 ← c3, c1 ← c2b (sibling of c2).
    const parentIdOf = (id: string) =>
      ({ c2: 'c1', c3: 'c2', c2b: 'c1' } as Record<string, string | undefined>)[id];
    expect(wouldCreateCycle(parentIdOf, 'c1', 'c1')).toBe(true); // self
    expect(wouldCreateCycle(parentIdOf, 'c1', 'c2')).toBe(true); // child
    expect(wouldCreateCycle(parentIdOf, 'c1', 'c3')).toBe(true); // grandchild
    expect(wouldCreateCycle(parentIdOf, 'c3', 'c1')).toBe(false); // ancestor OK
    expect(wouldCreateCycle(parentIdOf, 'c2', 'c2b')).toBe(false); // sibling OK
    expect(wouldCreateCycle(parentIdOf, 'c2', 'c3')).toBe(true); // own child
  });

  it('service PATCH rejects moving a category under its own descendant', async () => {
    // Tree: c1 (root), c2 under c1, c3 under c2. PATCH c1.parentId = c3 → cycle.
    const ancestors = [
      { id: 'c1', parentId: null },
      { id: 'c2', parentId: 'c1' },
      { id: 'c3', parentId: 'c2' },
    ];
    const prisma = {
      productCategory: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (args.where.id === 'c1') {
            return { id: 'c1', companyId: 'company-1', parentId: null, nameFa: 'ریشه', active: true };
          }
          if (args.where.id === 'c3') {
            return { id: 'c3', companyId: 'company-1', parentId: 'c2' };
          }
          return null;
        }),
        findMany: jest.fn(async () => ancestors),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new CategoriesService(prisma as never, audit as never);

    await expect(
      service.update(
        'company-1',
        'c1',
        { parentId: 'c3' },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: 'CATEGORY_CYCLE' });
    expect(prisma.productCategory.update).not.toHaveBeenCalled();
  });

  it('service PATCH rejects parentId === self immediately', async () => {
    const prisma = {
      productCategory: {
        findUnique: jest.fn(async () => ({
          id: 'c1',
          companyId: 'company-1',
          parentId: null,
          nameFa: 'ریشه',
          active: true,
        })),
        findMany: jest.fn(async () => []),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    const service = new CategoriesService(prisma as never, { recordTx: jest.fn() } as never);
    await expect(
      service.update('company-1', 'c1', { parentId: 'c1' }, { id: 'u1', username: 'a' }, {}),
    ).rejects.toMatchObject({ message: 'CATEGORY_CYCLE' });
  });
});

import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';

describeIntegration('p3b-01 category-hierarchy (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  const service = new CategoriesService(prisma as never, new AuditService(prisma as never));
  const admin = { id: '', username: 'admin' };
  const ids: string[] = [];

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
  });

  it('creates and reads back a 3-level tree through the live DB', async () => {
    const root = (await service.create(
      INTEGRATION_COMPANY_ID,
      { code: `T1-${marker}`, nameFa: 'سطح یک', nameEn: 'Level one' },
      admin,
      {},
    )) as { id: string };
    const mid = (await service.create(
      INTEGRATION_COMPANY_ID,
      { code: `T2-${marker}`, nameFa: 'سطح دو', parentId: root.id },
      admin,
      {},
    )) as { id: string };
    const leaf = (await service.create(
      INTEGRATION_COMPANY_ID,
      { code: `T3-${marker}`, nameFa: 'سطح سه', nameEn: 'Level three', parentId: mid.id },
      admin,
      {},
    )) as { id: string };
    ids.push(root.id, mid.id, leaf.id);

    const reread = (await service.getById(INTEGRATION_COMPANY_ID, root.id)) as {
      nameEn: string | null;
      children: Array<{ id: string }>;
    };
    expect(reread.nameEn).toBe('Level one');
    expect(reread.children.map((c) => c.id)).toContain(mid.id);

    const grandchild = await prisma.productCategory.findUniqueOrThrow({
      where: { id: leaf.id },
    });
    expect(grandchild.parentId).toBe(mid.id);
  });

  afterAll(async () => {
    await prisma.productCategory.deleteMany({ where: { id: { in: ids } } });
    await prisma.auditLog
      .deleteMany({ where: { entityType: 'product_category', entityId: { in: ids } } })
      .catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
