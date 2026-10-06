import { UomsService } from './uoms.service';

/**
 * c3b-13 — base-ratio-not-one blocked + base-unit promotion/demotion rules:
 * creating or patching a base unit to a ratio ≠ 1 → UOM_BASE_RATIO_ONE;
 * promoting a second base while one exists → UOM_BASE_UNIT_EXISTS
 * ("at most one", never "exactly one" — demotion is allowed).
 */
describe('c3b-13 uom-base-unit-rules', () => {
  const COMPANY = '00000000-0000-4000-8000-000000000001';
  const CATEGORY_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

  function makeService(existingBase: Record<string, unknown> | null) {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const otherUom = { id: 'uom-other', companyId: COMPANY, categoryId: CATEGORY_ID, isBaseUnit: false, conversionRatio: '1' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prisma: any = {
      uomCategory: {
        findUnique: jest.fn(async () => ({ id: CATEGORY_ID, companyId: COMPANY })),
      },
      uom: {
        findUnique: jest.fn(async (args: { where: { id: string } }) => {
          if (existingBase && args.where.id === existingBase.id) return existingBase;
          if (args.where.id === otherUom.id) return otherUom;
          return null;
        }),
        findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
          if (!existingBase) return null;
          const notSelf = (args.where as { id?: { not?: string } }).id?.not;
          return notSelf && notSelf === existingBase.id ? null : existingBase;
        }),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { id: 'uom-new', ...args.data };
          created.push(row);
          return row;
        }),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = { ...existingBase, ...args.data };
          updated.push(row);
          return row;
        }),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(prisma)),
    };
    const audit = { recordTx: jest.fn(), record: jest.fn() };
    const service = new UomsService(prisma as never, audit as never);
    return { service, prisma, created, updated, audit };
  }

  const actor = { id: 'u1', username: 'admin' };
  const createDto = (extra: Record<string, unknown>) => ({
    categoryId: CATEGORY_ID,
    nameFa: 'گرم',
    symbol: `g-${Math.random().toString(36).slice(2, 8)}`,
    conversionRatio: '0.001',
    ...extra,
  } as never);

  it('creating a base unit with ratio 2 → UOM_BASE_RATIO_ONE', async () => {
    const { service, created } = makeService(null);
    await expect(
      service.createUom(COMPANY, createDto({ isBaseUnit: true, conversionRatio: '2' }), actor, {}),
    ).rejects.toMatchObject({ message: 'UOM_BASE_RATIO_ONE' });
    expect(created).toHaveLength(0);
  });

  it('creating a base unit with ratio exactly 1 passes', async () => {
    const { service, created } = makeService(null);
    const row = (await service.createUom(
      COMPANY,
      createDto({ isBaseUnit: true, conversionRatio: '1' }),
      actor,
      {},
    )) as { isBaseUnit: boolean };
    expect(row.isBaseUnit).toBe(true);
    expect(created).toHaveLength(1);
  });

  it('patching an existing base to ratio 2 → UOM_BASE_RATIO_ONE (merged state)', async () => {
    const base = { id: 'uom-base', companyId: COMPANY, categoryId: CATEGORY_ID, isBaseUnit: true, conversionRatio: '1' };
    const { service, updated } = makeService(base);
    await expect(
      service.updateUom(COMPANY, 'uom-base', { conversionRatio: '2' } as never, actor, {}),
    ).rejects.toMatchObject({ message: 'UOM_BASE_RATIO_ONE' });
    expect(updated).toHaveLength(0);
  });

  it('promoting a second base while one exists → UOM_BASE_UNIT_EXISTS', async () => {
    const base = { id: 'uom-base', companyId: COMPANY, categoryId: CATEGORY_ID, isBaseUnit: true, conversionRatio: '1' };
    const { service } = makeService(base);
    await expect(
      service.updateUom(COMPANY, 'uom-other', { isBaseUnit: true } as never, actor, {}),
    ).rejects.toMatchObject({ message: 'UOM_BASE_UNIT_EXISTS' });
  });

  it('demoting the base (true → false) is allowed — at most one, never exactly one', async () => {
    const base = { id: 'uom-base', companyId: COMPANY, categoryId: CATEGORY_ID, isBaseUnit: true, conversionRatio: '1' };
    const { service, updated } = makeService(base);
    const row = (await service.updateUom(
      COMPANY,
      'uom-base',
      { isBaseUnit: false } as never,
      actor,
      {},
    )) as { isBaseUnit: boolean };
    expect(row.isBaseUnit).toBe(false);
    expect(updated).toHaveLength(1);
  });
});
