import { ForbiddenError } from '../common/errors';
import { TaxDefinitionService } from './tax.service';

/**
 * GATE TEST 13 — tax snapshot immutability: once a definition is used its
 * rate cannot change (TAX_DEFINITION_IMMUTABLE); a new rate means a new
 * definition; markUsed is one-way.
 */
describe('13 tax-snapshot-immutability', () => {
  const COMPANY = 'company-1';
  const DEF = {
    id: 'def-1',
    companyId: COMPANY,
    code: 'VAT_9',
    name: 'ارزش افزوده ۹٪',
    rate: '9.0000',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeMocks(usedMap: Record<string, string> | null = null) {
    const upserts: Record<string, unknown>[] = [];
    const prisma = {
      taxDefinition: {
        findUnique: jest.fn().mockResolvedValue(DEF),
        create: jest.fn(async (args: { data: object }) => ({ id: 'def-2', ...args.data })),
        update: jest.fn(async (args: { data: object }) => ({ ...DEF, ...args.data })),
        findMany: jest.fn().mockResolvedValue([]),
      },
      setting: {
        findUnique: jest.fn().mockResolvedValue(
          usedMap ? { value: usedMap } : null,
        ),
        upsert: jest.fn(async (args: Record<string, unknown>) => {
          upserts.push(args);
          return args;
        }),
      },
    };
    const audit = { record: jest.fn() };
    const service = new TaxDefinitionService(prisma as never, audit as never);
    return { service, prisma, upserts, audit };
  }

  it('markUsed sets usedAt once', async () => {
    const { service, upserts } = makeMocks();
    const usedAt = await service.markUsed(COMPANY, 'def-1');
    expect(usedAt).toBeInstanceOf(Date);
    expect(upserts).toHaveLength(1);
    expect(upserts[0].where).toEqual({ companyId_key: { companyId: COMPANY, key: 'tax.definition.used' } });
  });

  it('markUsed is one-way — the first stamp is kept', async () => {
    const original = new Date('2026-09-01T10:00:00Z');
    const { service, upserts } = makeMocks({ 'def-1': original.toISOString() });
    const usedAt = await service.markUsed(COMPANY, 'def-1');
    expect(usedAt.toISOString()).toBe(original.toISOString());
    expect(upserts).toHaveLength(0); // no write — already stamped
  });

  it('updating the rate after use is forbidden', async () => {
    const { service } = makeMocks({ 'def-1': new Date().toISOString() });
    await expect(
      service.update(
        COMPANY,
        'def-1',
        { rate: 10 },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      service.update(
        COMPANY,
        'def-1',
        { rate: 10 },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'TAX_DEFINITION_IMMUTABLE' });
  });

  it('renaming (non-rate fields) stays allowed after use', async () => {
    const { service, prisma } = makeMocks({ 'def-1': new Date().toISOString() });
    await expect(
      service.update(COMPANY, 'def-1', { name: 'new name' }, { id: 'u1', username: 'admin' }, {}),
    ).resolves.toBeTruthy();
    expect(prisma.taxDefinition.update).toHaveBeenCalled();
  });

  it('a new definition carries the new rate', async () => {
    const { service, prisma } = makeMocks({ 'def-1': new Date().toISOString() });
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
