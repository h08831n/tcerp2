import { QueueService } from './queue.service';
import { QueueHandlerRegistry } from './queue.handlers';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
  testUuid,
} from '../testing/integration';

/**
 * corr-06 — null-scoped unique dedupe at the DB level (migration
 * 20241007000000_p3a_corrections):
 *   - `queue_jobs_platform_idempotency_uniq` on (idempotency_key) WHERE
 *     company_id IS NULL guarantees DB-level dedupe for PLATFORM jobs;
 *   - the composite (companyId, idempotencyKey) unique stays for company jobs;
 *   - `user_permission_overrides_platform_uniq` on (user_id, permission_id)
 *     WHERE company_id IS NULL guarantees a single platform-wide override.
 * QueueService.enqueue no longer pre-checks: it inserts and resolves races on
 * P2002 by re-fetching the winning row.
 */
describeIntegration('corr-06 null-scoped-unique (live DB)', () => {
  const prisma = integrationPrisma();
  // BullMQ producer stub: unavailable → the DB-polling path (no Redis needed).
  const bullmq = { add: jest.fn(async () => false), removeJob: jest.fn(async () => undefined) };
  const service = new QueueService(prisma as never, new QueueHandlerRegistry(), bullmq as never);

  const jobKeysUsed: string[] = [];
  const createdCompanies: string[] = [];
  let userId: string;
  let permissionId: string;

  it('8 concurrent enqueues with the same PLATFORM idempotencyKey → exactly 1 row, one shared job id', async () => {
    const key = `corr06-platform-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    jobKeysUsed.push(key);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        service.enqueue({ jobType: 'corr06.echo', payload: { n: 1 }, idempotencyKey: key }),
      ),
    );

    const rows = await prisma.queueJob.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(1);
    expect(rows[0].companyId).toBeNull();

    const fulfilledIds = results.flatMap((r) =>
      r.status === 'fulfilled' ? [r.value.id] : [],
    );
    // Every call resolves to the SAME winning row (rejections are acceptable
    // only as duplicates resolved to the same row — here the re-fetch makes
    // them all resolve).
    expect(new Set(fulfilledIds)).toEqual(new Set([rows[0].id]));
    // Only the insert winner hands the row to BullMQ.
    expect(bullmq.add).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('two DIFFERENT companies with the same key → 2 rows (composite unique stays)', async () => {
    const key = `corr06-company-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    jobKeysUsed.push(key);
    const companyB = testUuid();
    createdCompanies.push(companyB);
    await prisma.company.create({ data: { id: companyB, nameFa: `شرکت بی کُر۶ ${Date.now()}` } });

    const [a, b] = await Promise.all([
      service.enqueue({
        jobType: 'corr06.echo',
        payload: {},
        companyId: INTEGRATION_COMPANY_ID,
        idempotencyKey: key,
      }),
      service.enqueue({
        jobType: 'corr06.echo',
        payload: {},
        companyId: companyB,
        idempotencyKey: key,
      }),
    ]);

    expect(a.id).not.toBe(b.id);
    const rows = await prisma.queueJob.findMany({ where: { idempotencyKey: key } });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.companyId))).toEqual(
      new Set([INTEGRATION_COMPANY_ID, companyB]),
    );
  });

  it('two concurrent creates of the same (user, permission) PLATFORM override → 1 row', async () => {
    const user = await prisma.user.create({
      data: { username: `corr06-${Date.now()}`, passwordHash: 'x' },
      select: { id: true },
    });
    userId = user.id;
    const permission = await prisma.permission.create({
      data: {
        code: `corr06.perm.${Date.now()}`,
        module: 'test',
        action: 'test',
      },
      select: { id: true },
    });
    permissionId = permission.id;

    const attempt = () =>
      prisma.userPermissionOverride.create({
        data: { userId: user.id, permissionId: permission.id, companyId: null, mode: 'GRANT' },
      });
    const results = await Promise.allSettled([attempt(), attempt()]);

    const rows = await prisma.userPermissionOverride.findMany({
      where: { userId: user.id, permissionId: permission.id, companyId: null },
    });
    expect(rows).toHaveLength(1); // user_permission_overrides_platform_uniq
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  afterAll(async () => {
    if (jobKeysUsed.length) {
      await prisma.queueJob.deleteMany({ where: { idempotencyKey: { in: jobKeysUsed } } });
    }
    if (userId) await prisma.userPermissionOverride.deleteMany({ where: { userId } });
    if (userId) await prisma.user.deleteMany({ where: { id: userId } });
    if (permissionId) await prisma.permission.deleteMany({ where: { id: permissionId } });
    if (createdCompanies.length) {
      await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });
    }
    await disconnectIntegrationPrisma();
  });
});
