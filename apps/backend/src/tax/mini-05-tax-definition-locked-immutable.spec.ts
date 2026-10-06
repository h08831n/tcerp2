import { ForbiddenError } from '../common/errors';
import { TaxDefinitionService } from './tax.service';

/**
 * MINI-GATE 05 — tax-definition-locked-immutable: once lockedAt is set the
 * definition can never change its code/rate/name (isActive toggle allowed),
 * and the lock itself is impossible to clear — no code path writes
 * lockedAt = null.
 */
describe('mini-05 tax-definition-locked-immutable', () => {
  const COMPANY = 'company-1';
  const LOCKED_AT = new Date('2026-10-01T08:00:00Z');
  const LOCKED = {
    id: 'def-locked',
    companyId: COMPANY,
    code: 'VAT_9',
    name: 'ارزش افزوده ۹٪',
    rate: '9.0000',
    isActive: true,
    lockedAt: LOCKED_AT,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  function makeMocks() {
    const prisma = {
      taxDefinition: {
        findUnique: jest.fn().mockResolvedValue(LOCKED),
        update: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          ...LOCKED,
          ...args.data,
        })),
      },
    };
    const service = new TaxDefinitionService(prisma as never, { record: jest.fn() } as never);
    return { service, prisma };
  }

  it('a locked definition rejects rate changes', async () => {
    const { service, prisma } = makeMocks();
    await expect(
      service.update(COMPANY, 'def-locked', { rate: 12.5 }, { id: 'u1', username: 'a' }, {}),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(prisma.taxDefinition.update).not.toHaveBeenCalled();
  });

  it('a locked definition rejects code changes', async () => {
    const { service } = makeMocks();
    await expect(
      service.update(COMPANY, 'def-locked', { code: 'VAT_10' }, { id: 'u1', username: 'a' }, {}),
    ).rejects.toMatchObject({ message: 'TAX_DEFINITION_IMMUTABLE', statusCode: 403 });
  });

  it('a locked definition rejects name changes', async () => {
    const { service } = makeMocks();
    await expect(
      service.update(COMPANY, 'def-locked', { name: 'تلاش برای تغییر' }, { id: 'u1', username: 'a' }, {}),
    ).rejects.toMatchObject({ message: 'TAX_DEFINITION_IMMUTABLE' });
  });

  it('isActive may still toggle on a locked definition', async () => {
    const { service, prisma } = makeMocks();
    await expect(
      service.update(COMPANY, 'def-locked', { isActive: false }, { id: 'u1', username: 'a' }, {}),
    ).resolves.toMatchObject({ isActive: false });
    expect(prisma.taxDefinition.update).toHaveBeenCalledWith({
      where: { id: 'def-locked' },
      data: expect.objectContaining({ isActive: false }),
    });
  });

  it('unlock is impossible: markUsed never clears or moves the stamp', async () => {
    const { service, prisma } = makeMocks();
    const lockedAt = await service.markUsed(COMPANY, 'def-locked');
    expect(lockedAt.toISOString()).toBe(LOCKED_AT.toISOString());
    expect(prisma.taxDefinition.update).not.toHaveBeenCalled();
    // And no API/DTO path can pass lockedAt: null — update() only forwards
    // code/name/rate/isActive, so the stamp cannot be overwritten.
    await service.update(COMPANY, 'def-locked', { isActive: true }, { id: 'u1', username: 'a' }, {});
    expect(prisma.taxDefinition.update).toHaveBeenCalledWith({
      where: { id: 'def-locked' },
      data: expect.not.objectContaining({ lockedAt: expect.anything() }),
    });
  });
});
