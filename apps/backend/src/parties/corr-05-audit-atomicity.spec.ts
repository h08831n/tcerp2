import { PartiesService } from './parties.service';
import { FinancialResponsibilityService } from './financial-responsibility.service';
import { AuditService } from '../audit/audit.service';
import { TimelineService } from './timeline.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';

/**
 * corr-05 — audit atomicity: business mutation + TimelineEvent + AuditLog run
 * inside ONE $transaction. AuditService.recordTx(tx, entry) writes with the
 * caller's transaction client and PROPAGATES failures, so an audit-write
 * failure rolls the party mutation back.
 */
describe('corr-05 audit-atomicity (unit)', () => {
  const COMPANY = 'company-1';

  function makeService(recordTxImpl?: () => Promise<void>) {
    const trx = {
      party: { create: jest.fn(async () => ({ id: 'party-new', nameFa: 'نام', type: 'PERSON' })) },
      timelineEvent: { create: jest.fn(async () => ({})) },
    };
    const recordTx = jest.fn(recordTxImpl ?? (async () => undefined));
    const prisma = {
      partyPhone: { findFirst: jest.fn(async () => null) },
      $queryRaw: jest.fn(async () => []),
      userCompany: { findFirst: jest.fn(async () => ({ userId: 'u1' })) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const service = new PartiesService(
      prisma as never,
      { record: jest.fn(), recordTx } as never,
      new TimelineService(prisma as never),
    );
    return { service, trx, recordTx, prisma };
  }

  it('create writes the audit through the SAME transaction client as the mutation', async () => {
    const { service, recordTx, trx } = makeService();
    await service.create(
      COMPANY,
      { type: 'PERSON', nameFa: 'علی' },
      { id: 'u1', username: 'sales' },
      {},
    );
    expect(recordTx).toHaveBeenCalledTimes(1);
    // The tx passed to recordTx is the one the mutation used (atomicity by
    // construction).
    expect((recordTx.mock.calls[0] as unknown[])[0]).toBe(trx);
  });

  it('an audit failure inside the transaction propagates (unit level)', async () => {
    const { service } = makeService(() => Promise.reject(new Error('audit down')));
    await expect(
      service.create(COMPANY, { type: 'PERSON', nameFa: 'علی' }, { id: 'u1', username: 'sales' }, {}),
    ).rejects.toThrow('audit down');
  });
});

describeIntegration('corr-05 audit-atomicity (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  let adminId: string;

  beforeAll(async () => {
    const admin = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    adminId = admin.id;
  });

  function makeService(audit: AuditService) {
    return new PartiesService(prisma as never, audit, new TimelineService(prisma as never));
  }

  it('corr-05b: happy path — the audit row is committed in the SAME transaction', async () => {
    const service = makeService(new AuditService(prisma as never));
    const { party } = await service.create(
      INTEGRATION_COMPANY_ID,
      { type: 'PERSON', nameFa: `اتمی بودن ممیزی کُر۵ ${marker}` },
      { id: adminId, username: 'admin' },
      {},
    );
    try {
      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'party', entityId: party.id, action: 'CREATE' },
      });
      expect(audits).toHaveLength(1);
      // Timeline event committed in the same transaction as well.
      const events = await prisma.timelineEvent.findMany({
        where: { entityType: 'PARTY', entityId: party.id, type: 'PARTY_CREATED' },
      });
      expect(events).toHaveLength(1);
    } finally {
      await prisma.party.deleteMany({ where: { id: party.id } });
      await prisma.timelineEvent.deleteMany({
        where: { entityType: 'PARTY', entityId: party.id },
      });
    }
  });

  it('corr-05: an injected audit failure rolls the party mutation back', async () => {
    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValue(new Error('audit write failed'));
    const service = makeService(audit);

    const before = await prisma.party.count({ where: { companyId: INTEGRATION_COMPANY_ID } });
    await expect(
      service.create(
        INTEGRATION_COMPANY_ID,
        { type: 'PERSON', nameFa: `هرگز ذخیره نشود کُر۵ ${marker}` },
        { id: adminId, username: 'admin' },
        {},
      ),
    ).rejects.toThrow('audit write failed');
    const after = await prisma.party.count({ where: { companyId: INTEGRATION_COMPANY_ID } });
    expect(after).toBe(before); // rolled back — no party row, no timeline row
  });

  it('financial responsibility add: audit failure rolls the membership back', async () => {
    const responsible = await prisma.party.create({
      data: { companyId: INTEGRATION_COMPANY_ID, type: 'COMPANY', nameFa: `مسئول کُر۵ ${marker}` },
    });
    const member = await prisma.party.create({
      data: { companyId: INTEGRATION_COMPANY_ID, type: 'COMPANY', nameFa: `عضو کُر۵ ${marker}` },
    });
    const audit = new AuditService(prisma as never);
    jest.spyOn(audit, 'recordTx').mockRejectedValue(new Error('audit write failed'));
    const service = new FinancialResponsibilityService(
      prisma as never,
      audit,
      new TimelineService(prisma as never),
    );
    await expect(
      service.addMember(
        INTEGRATION_COMPANY_ID,
        member.id,
        { responsiblePartyId: responsible.id },
        { id: adminId, username: 'admin' },
        {},
      ),
    ).rejects.toThrow('audit write failed');
    expect(
      await prisma.financialResponsibility.count({
        where: { companyId: INTEGRATION_COMPANY_ID, memberPartyId: member.id },
      }),
    ).toBe(0);

    await prisma.party.deleteMany({ where: { id: { in: [member.id, responsible.id] } } });
  });

  afterAll(async () => {
    await disconnectIntegrationPrisma();
  });
});
