import { TemplatesService } from './templates.service';
import { CategoriesService } from './categories.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';

/**
 * p3b-18 — audit-rollback-atomicity: template create writes the AuditLog row
 * through the SAME transaction (recordTx); an injected audit failure rolls
 * the template back — no orphan rows. (corr-05 pattern.)
 */
describe('p3b-18 audit-rollback-atomicity (unit)', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'admin' };

  function makeService(recordTxImpl?: () => Promise<void>) {
    const trx = {
      productTemplate: {
        create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'tpl-new',
          version: 1,
          ...args.data,
        })),
      },
    };
    const recordTx = jest.fn(recordTxImpl ?? (async () => undefined));
    const prisma = {
      productCategory: { findUnique: jest.fn(async () => ({ id: 'cat-1', companyId: COMPANY, active: true })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const service = new TemplatesService(prisma as never, { recordTx } as never);
    return { service, trx, recordTx, prisma };
  }

  it('create writes the audit through the SAME transaction client', async () => {
    const { service, recordTx, trx } = makeService();
    await service.create(
      COMPANY,
      { categoryId: 'cat-1', nameFa: 'محصول', internalCode: 'P-1' },
      actor,
      {},
    );
    expect(recordTx).toHaveBeenCalledTimes(1);
    expect((recordTx.mock.calls[0] as unknown[])[0]).toBe(trx);
  });

  it('an audit failure inside the transaction propagates (no template returned)', async () => {
    const { service } = makeService(() => Promise.reject(new Error('audit down')));
    await expect(
      service.create(
        COMPANY,
        { categoryId: 'cat-1', nameFa: 'محصول', internalCode: 'P-1' },
        actor,
        {},
      ),
    ).rejects.toThrow('audit down');
  });
});

describeIntegration('p3b-18 audit-rollback-atomicity (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  let adminId: string;
  let categoryId: string;

  beforeAll(async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    adminId = admin.id;
    const categories = new CategoriesService(
      prisma as never,
      new AuditService(prisma as never),
    );
    const cat = (await categories.create(
      INTEGRATION_COMPANY_ID,
      { code: `AUD-${marker}`, nameFa: 'دسته ممیزی' },
      { id: adminId, username: 'admin' },
      {},
    )) as { id: string };
    categoryId = cat.id;
  });

  it('happy path: the audit row is committed in the SAME transaction', async () => {
    const service = new TemplatesService(prisma as never, new AuditService(prisma as never));
    const tpl = (await service.create(
      INTEGRATION_COMPANY_ID,
      { categoryId, nameFa: 'محصول ممیزی کُر۱۸', internalCode: `AUD-${marker}` },
      { id: adminId, username: 'admin' },
      {},
    )) as { id: string };

    try {
      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'product_template', entityId: tpl.id, action: 'CREATE' },
      });
      expect(audits).toHaveLength(1);
    } finally {
      await prisma.productTemplate.deleteMany({ where: { id: tpl.id } });
    }
  });

  it('an injected audit failure rolls the template mutation back', async () => {
    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValue(new Error('audit write failed'));
    const service = new TemplatesService(prisma as never, audit);

    const before = await prisma.productTemplate.count({
      where: { companyId: INTEGRATION_COMPANY_ID },
    });
    await expect(
      service.create(
        INTEGRATION_COMPANY_ID,
        { categoryId, nameFa: 'هرگز ذخیره نشود کُر۱۸', internalCode: `AUD-FAIL-${marker}` },
        { id: adminId, username: 'admin' },
        {},
      ),
    ).rejects.toThrow('audit write failed');
    const after = await prisma.productTemplate.count({
      where: { companyId: INTEGRATION_COMPANY_ID },
    });
    expect(after).toBe(before); // rolled back — no template row, no audit row
  });

  afterAll(async () => {
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await disconnectIntegrationPrisma();
  });
});
