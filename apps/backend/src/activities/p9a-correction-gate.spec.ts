import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TimelineService } from '../parties/timeline.service';
import { AuditService } from '../audit/audit.service';
import { ActivityService } from '../activities/activity.service';
import { TEST_INTEGRATION, disconnectIntegrationPrisma } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(180000);

const DB_URL = process.env.DATABASE_URL;

if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };

const COMPANY_A = '8a8a8a8a-8a8a-4a8a-8a8a-8a8a8a8a8a8a';

/** Two INDEPENDENT Prisma clients for concurrency tests. */
let clientA: PrismaClient;
let clientB: PrismaClient;

describe('p9a-correction — record-level authz, atomicity, idempotency (Phase 9A gate)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let service: ActivityService;
  let timeline: TimelineService;
  let audit: AuditService;
  let typeCode = '';
  let ownerId = '';
  let strangerId = '';

  const cleanup = async () => {
    for (const c of [COMPANY_A]) {
      await prisma.timelineEvent.deleteMany({ where: { companyId: c } }).catch(() => undefined);
      await prisma.activity.deleteMany({ where: { companyId: c } }).catch(() => undefined);
      await prisma.activityType.deleteMany({ where: { companyId: c } } ).catch(() => undefined);
      await prisma.userCompanyRole.deleteMany({ where: { companyId: c } }).catch(() => undefined);
      await prisma.company.delete({ where: { id: c } }).catch(() => undefined);
    }
    await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } }).catch(() => undefined);
  };

  beforeAll(async () => {
    if (!TEST_INTEGRATION || !DB_URL) return;
    prismaService = new PrismaService();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    const auditService = new AuditService(prismaService);
    timeline = new TimelineService(prismaService);
    audit = auditService;
    service = new ActivityService(prismaService, timeline, auditService);
    clientA = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    clientB = new PrismaClient({ datasources: { db: { url: DB_URL } } });
    await Promise.all([clientA.$connect(), clientB.$connect()]);

    await cleanup();
    await prisma.company.create({ data: { id: COMPANY_A, nameFa: 'p9c شرکت', status: 'ACTIVE' } });
    const owner = await prisma.user.create({
      data: { username: `p9c-owner-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    ownerId = owner.id;
    const stranger = await prisma.user.create({
      data: { username: `p9c-stranger-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
    });
    strangerId = stranger.id;
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    for (const uid of [ownerId, strangerId]) {
      await prisma.userCompanyRole.create({
        data: { userId: uid, companyId: COMPANY_A, roleId: adminRole.id },
      });
    }
    const type = await prisma.activityType.create({
      data: { companyId: COMPANY_A, code: 'FOLLOW_UP', nameFa: 'پیگیری' },
    });
    typeCode = type.code;
  });

  afterAll(async () => {
    if (!prismaService) return;
    await cleanup();
    await Promise.all([clientA?.$disconnect(), clientB?.$disconnect()]).catch(() => undefined);
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : (name: string, fn: jest.ProvidesCallback) => it.skip(name, fn);

  function ownViewer() {
    return { userId: ownerId, scopeAll: false };
  }

  itif('p9c-01 OWN-scope user cannot read or mutate a stranger activity by UUID', async () => {
    // stranger creates their own activity
    const created = await service.create(
      COMPANY_A,
      { typeCode, title: 'خودم', relatedEntityType: 'party', relatedEntityId: COMPANY_A, assignedToId: strangerId },
      { id: strangerId, username: 'stranger' },
    );
    // owner (different user, OWN scope) cannot read it
    await expect(
      service.getById(COMPANY_A, created.id, { userId: ownerId, scopeAll: false }),
    ).rejects.toThrow('Activity not found');
    // cannot complete/cancel/update/delete it either
    await expect(
      service.complete(COMPANY_A, created.id, { id: ownerId, username: 'owner' }, undefined, ownViewer()),
    ).rejects.toThrow('Activity not found');
    await expect(
      service.cancel(COMPANY_A, created.id, { id: ownerId, username: 'owner' }, 'x', ownViewer()),
    ).rejects.toThrow('Activity not found');
    await expect(
      service.update(COMPANY_A, created.id, { title: 'x' }, { id: ownerId, username: 'owner' }, false, ownViewer()),
    ).rejects.toThrow('Activity not found');
    await expect(
      service.delete(COMPANY_A, created.id, { id: ownerId, username: 'owner' }, ownViewer()),
    ).rejects.toThrow('Activity not found');
    // and the row is untouched
    const row = await prisma.activity.findUniqueOrThrow({ where: { id: created.id } });
    expect(row.status).toBe('PENDING');
  });

  itif('p9a-02 create is ATOMIC: audit failure rolls back the activity creation', async () => {
    // inject: the audit write inside the transaction fails
    const failingAudit = new AuditService(prismaService);
    const failingService = new ActivityService(prismaService, timeline, failingAudit);
    const originalCreate = (prismaService as unknown as { auditLog: { create: unknown } }).auditLog.create;
    // point the tx client's auditLog.create at a rejector via $transaction spy
    const realTransaction = prisma.$transaction.bind(prisma);
    const txSpy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce((async (arg: unknown) => {
        return realTransaction(async (tx: Prisma.TransactionClient) => {
          const failingTx = new Proxy(tx, {
            get(target, prop) {
              if (prop === 'auditLog') {
                return new Proxy(target.auditLog, {
                  get(t, p) {
                    if (p === 'create') {
                      return () => Promise.reject(new Error('INJECTED: audit failure'));
                    }
                    const v = Reflect.get(t, p, t);
                    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
                  },
                });
              }
              return Reflect.get(target, prop);
            },
          });
          return (arg as (tx: Prisma.TransactionClient) => unknown)(failingTx);
        });
      }) as never);
    let hit = 0;
    try {
      await expect(
        failingService.create(
          COMPANY_A,
          { typeCode, title: 'rollback target', relatedEntityType: 'party', relatedEntityId: COMPANY_A },
          ACTOR,
        ),
      ).rejects.toThrow('INJECTED');
      hit = 1;
    } finally {
      txSpy.mockRestore();
    }
    expect(hit).toBe(1);
    // rolled back: NO activity, NO timeline event, NO audit row persisted
    // (counts compared before/after - other tests may have valid rows)
    expect(await prisma.activity.count({ where: { companyId: COMPANY_A, title: 'rollback target' } })).toBe(0);
    expect(
      await prisma.timelineEvent.count({
        where: { companyId: COMPANY_A, type: 'ACTIVITY_CREATED', data: { path: ['title'], equals: 'rollback target' } },
      }),
    ).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { companyId: COMPANY_A, entityType: 'activity', newValues: { path: ['title'], equals: 'rollback target' } },
      }),
    ).toBe(0);
    void originalCreate;
  });

  itif('p9c-03 SYSTEM creation with the SAME idempotency key concurrently creates exactly ONE activity', async () => {
    const key = `same-key-${Date.now()}`;
    const results = await Promise.allSettled([
      service.createSystemActivity(COMPANY_A, {
        typeCode,
        title: 'سیستمی هم‌کلید',
        relatedEntityType: 'party',
        relatedEntityId: COMPANY_A,
        idempotencyKey: key,
      }),
      clientA.$transaction(async (tx) => {
        // simulate a concurrent independent writer through another service
        // instance sharing the same DB (independent client)
        const svc = new ActivityService(new PrismaService(), timeline, audit);
        void tx;
        return svc.createSystemActivity(COMPANY_A, {
          typeCode,
          title: 'سیستمی هم‌کلید',
          relatedEntityType: 'party',
          relatedEntityId: COMPANY_A,
          idempotencyKey: key,
        });
      }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBe(2);
    // both calls resolve, but only ONE activity row exists for the key
    const rows = await prisma.activity.findMany({
      where: { companyId: COMPANY_A, idempotencyKey: key },
    });
    expect(rows).toHaveLength(1);
    // both calls return the SAME activity id
    const [r1, r2] = results.map((r) => (r as PromiseFulfilledResult<{ activityId: string; created: boolean }>)).map((r) => r.value);
    expect(r1.activityId).toBe(r2.activityId);
  });

  itif('p9c-04 SYSTEM creation with DIFFERENT idempotency keys creates DISTINCT activities', async () => {
    const base = Date.now();
    const [r1, r2] = await Promise.all([
      service.createSystemActivity(COMPANY_A, {
        typeCode,
        title: 'کلید متمایز ۱',
        relatedEntityType: 'party',
        relatedEntityId: COMPANY_A,
        idempotencyKey: `key-${base}-1`,
      }),
      service.createSystemActivity(COMPANY_A, {
        typeCode,
        title: 'کلید متمایز ۲',
        relatedEntityType: 'party',
        relatedEntityId: COMPANY_A,
        idempotencyKey: `key-${base}-2`,
      }),
    ]);
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(true);
    expect(r1.activityId).not.toBe(r2.activityId); // different keys are NOT collapsed
    expect(
      await prisma.activity.count({ where: { companyId: COMPANY_A, idempotencyKey: { in: [r1.activityId && `key-${base}-1`, `key-${base}-2`] } } }),
    ).toBe(2);
  });
});
