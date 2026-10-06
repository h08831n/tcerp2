import { ForbiddenError } from '../common/errors';
import { TaxDefinitionService } from './tax.service';

/**
 * GATE TEST 13 — tax snapshot immutability (Mini-Gate #4): `lockedAt` is set
 * on first use and never cleared; afterwards code/rate/name changes are
 * forbidden (TAX_DEFINITION_IMMUTABLE) — a new rate means a new definition;
 * isActive may still be toggled.
 */
describe('13 tax-snapshot-immutability', () => {
  const COMPANY = 'company-1';
  const UNLOCKED = {
    id: 'def-1',
    companyId: COMPANY,
    code: 'VAT_9',
    name: 'ارزش افزوده ۹٪',
    rate: '9.0000',
    isActive: true,
    lockedAt: null as Date | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const LOCKED_AT = new Date('2026-09-01T10:00:00Z');
  const LOCKED = { ...UNLOCKED, lockedAt: LOCKED_AT };

  function makeMocks(definition: typeof UNLOCKED = UNLOCKED) {
    const prisma = {
      taxDefinition: {
        findUnique: jest.fn().mockResolvedValue(definition),
        create: jest.fn(async (args: { data: object }) => ({ id: 'def-2', ...args.data })),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          ...definition,
          ...args.data,
        })),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const audit = { record: jest.fn() };
    const service = new TaxDefinitionService(prisma as never, audit as never);
    return { service, prisma, audit };
  }

  it('markUsed sets lockedAt once (replaces the old Setting workaround)', async () => {
    const { service, prisma } = makeMocks(UNLOCKED);
    const lockedAt = await service.markUsed(COMPANY, 'def-1');
    expect(lockedAt).toBeInstanceOf(Date);
    expect(prisma.taxDefinition.update).toHaveBeenCalledWith({
      where: { id: 'def-1' },
      data: { lockedAt: expect.any(Date) },
    });
  });

  it('markUsed is one-way — the first stamp is kept', async () => {
    const { service, prisma } = makeMocks(LOCKED);
    const lockedAt = await service.markUsed(COMPANY, 'def-1');
    expect(lockedAt.toISOString()).toBe(LOCKED_AT.toISOString());
    expect(prisma.taxDefinition.update).not.toHaveBeenCalled();
  });

  it('markUsed works inside a transaction client (tx passed through)', async () => {
    const tx = {
      taxDefinition: {
        findUnique: jest.fn().mockResolvedValue(UNLOCKED),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          ...UNLOCKED,
          ...args.data,
        })),
      },
    };
    const service = new TaxDefinitionService(tx as never, { record: jest.fn() } as never);
    const lockedAt = await service.markUsed(COMPANY, 'def-1', tx as never);
    expect(lockedAt).toBeInstanceOf(Date);
    expect(tx.taxDefinition.update).toHaveBeenCalled();
  });

  it('updating the rate after lock is forbidden', async () => {
    const { service, prisma } = makeMocks(LOCKED);
    await expect(
      service.update(COMPANY, 'def-1', { rate: 10 }, { id: 'u1', username: 'admin' }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.update(COMPANY, 'def-1', { rate: 10 }, { id: 'u1', username: 'admin' }, {}),
    ).rejects.toMatchObject({ message: 'TAX_DEFINITION_IMMUTABLE' });
    expect(prisma.taxDefinition.update).not.toHaveBeenCalled();
  });

  it('updating the code or name after lock is forbidden', async () => {
    const { service } = makeMocks(LOCKED);
    await expect(
      service.update(COMPANY, 'def-1', { code: 'VAT_10' }, { id: 'u1', username: 'admin' }, {}),
    ).rejects.toMatchObject({ message: 'TAX_DEFINITION_IMMUTABLE' });
    await expect(
      service.update(COMPANY, 'def-1', { name: 'new name' }, { id: 'u1', username: 'admin' }, {}),
    ).rejects.toMatchObject({ message: 'TAX_DEFINITION_IMMUTABLE' });
  });

  it('toggling isActive stays allowed after lock (but no unlock: lockedAt is not writable)', async () => {
    const { service, prisma } = makeMocks(LOCKED);
    const updated = await service.update(
      COMPANY,
      'def-1',
      { isActive: false },
      { id: 'u1', username: 'admin' },
      {},
    );
    expect(updated.isActive).toBe(false);
    expect(prisma.taxDefinition.update).toHaveBeenCalledWith({
      where: { id: 'def-1' },
      data: { code: undefined, name: undefined, rate: undefined, isActive: false },
    });
  });

  it('before lock, rate/name/code changes are allowed', async () => {
    const { service } = makeMocks(UNLOCKED);
    await expect(
      service.update(
        COMPANY,
        'def-1',
        { rate: 10, name: 'نرخ جدید' },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).resolves.toBeTruthy();
  });

  it('a new definition carries the new rate', async () => {
    const { service, prisma } = makeMocks(LOCKED);
    const created = await service.create(
      COMPANY,
      { code: 'VAT_10', name: 'ارزش افزوده ۱۰٪', rate: 10 },
      { id: 'u1', username: 'admin' },
      {},
    );
    expect(created.id).toBe('def-2');
    expect(prisma.taxDefinition.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ companyId: COMPANY, code: 'VAT_10', rate: 10 }),
    });
  });
});
