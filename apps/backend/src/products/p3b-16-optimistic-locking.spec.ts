import { Prisma } from '@prisma/client';
import { TemplatesService } from './templates.service';
import { ConflictError } from '../common/errors';

/**
 * p3b-16 — optimistic-locking: PATCHing a template with a stale version is
 * rejected with ConflictError `VERSION_CONFLICT` (update runs against
 * where {id, version}; P2025 maps to the stable domain error).
 */
describe('p3b-16 optimistic-locking', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'admin' };

  function makeService(updateImpl: (args: unknown) => Promise<unknown>) {
    const trx = {
      productTemplate: { update: jest.fn(updateImpl) },
    };
    const prisma = {
      productTemplate: {
        findUnique: jest.fn(async () => ({
          id: 'tpl-1',
          companyId: COMPANY,
          version: 3,
          nameFa: 'قدیمی',
        })),
      },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new TemplatesService(prisma as never, audit as never);
    return { service, prisma, trx, audit };
  }
  it('a matching version updates and bumps the version', async () => {
    const { service, trx } = makeService(async () => ({
      id: 'tpl-1',
      version: 4,
      nameFa: 'جدید',
    }));
    const row = (await service.update(
      COMPANY,
      'tpl-1',
      { version: 3, nameFa: 'جدید' },
      actor,
      {},
    )) as { version: number };
    expect(row.version).toBe(4);
    expect(trx.productTemplate.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tpl-1', version: 3 } }),
    );
  });

  it('a stale version → ConflictError VERSION_CONFLICT', async () => {
    const stale = new Prisma.PrismaClientKnownRequestError('Record to update not found', {
      code: 'P2025',
      clientVersion: 'test',
    });
    const { service, trx, audit } = makeService(async () => {
      throw stale;
    });
    await expect(
      service.update(COMPANY, 'tpl-1', { version: 2, nameFa: 'ناهمزمان' }, actor, {}),
    ).rejects.toThrow(ConflictError);
    await expect(
      service.update(COMPANY, 'tpl-1', { version: 2, nameFa: 'ناهمزمان' }, actor, {}),
    ).rejects.toThrow('VERSION_CONFLICT');
    // audit never runs when the mutation failed
    expect(audit.recordTx).not.toHaveBeenCalled();
  });
});
