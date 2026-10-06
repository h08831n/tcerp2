import { Prisma } from '@prisma/client';
import { QueueService } from './queue.service';
import { QueueHandlerRegistry } from './queue.handlers';

/**
 * Extra gate coverage — enqueue idempotency with the BullMQ producer mocked:
 * an existing idempotencyKey resolves to the SAME durable job id and never
 * adds a second BullMQ job. corr-06: there is NO race-prone pre-check —
 * enqueue inserts first and resolves duplicates through the DB unique
 * indexes on P2002: the composite (companyId, idempotencyKey) unique for
 * company jobs and the partial unique `queue_jobs_platform_idempotency_uniq`
 * (idempotency_key WHERE company_id IS NULL) for platform jobs.
 * Mini-Gate: idempotency is (companyId, idempotencyKey) — the same key in two
 * different companies creates TWO jobs (mini-07).
 */
describe('queue enqueue idempotency (mocked BullMQ)', () => {
  const EXISTING = {
    id: 'job-existing-1',
    jobType: 'test.echo',
    payload: { a: 1 },
    companyId: null,
    queueName: 'default',
    priority: 'NORMAL',
    status: 'PENDING',
    attemptCount: 0,
    maxAttempts: 5,
    scheduledAt: new Date(),
    startedAt: null,
    finishedAt: null,
    lastError: null,
    idempotencyKey: 'op-123',
    createdBy: null,
    createdAt: new Date(),
  };

  function makeMocks(existing: unknown, createThrows = false) {
    const bullmq = { add: jest.fn(async () => true), removeJob: jest.fn() };
    const prisma = {
      queueJob: {
        findFirst: jest.fn(
          async (args: {
            where: { companyId?: string | null; idempotencyKey?: string };
          }) =>
            args.where.idempotencyKey === 'op-123' &&
            (args.where.companyId ?? null) === ((EXISTING as { companyId: string | null }).companyId ?? null)
              ? existing
              : null,
        ),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          if (createThrows) {
            throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
              code: 'P2002',
              clientVersion: 'test',
            });
          }
          return { ...EXISTING, ...args.data };
        }),
      },
    };
    const service = new QueueService(
      prisma as never,
      new QueueHandlerRegistry(),
      bullmq as never,
    );
    return { service, bullmq, prisma };
  }

  it('an existing key (P2002 on insert) resolves to the same row and does not touch BullMQ', async () => {
    // corr-06: insert-first — the DB unique index rejects the duplicate and
    // the service re-fetches the winner. No pre-check ever ran.
    const { service, bullmq, prisma } = makeMocks(EXISTING, true);
    const result = await service.enqueue({
      jobType: 'test.echo',
      payload: { a: 1 },
      idempotencyKey: 'op-123',
    });
    expect(result.id).toBe('job-existing-1');
    expect(prisma.queueJob.create).toHaveBeenCalledTimes(1);
    expect(bullmq.add).not.toHaveBeenCalled();
    expect(prisma.queueJob.findFirst).toHaveBeenCalledWith({
      where: { companyId: null, idempotencyKey: 'op-123' },
    });
  });

  it('a fresh job is persisted AND handed to BullMQ with jobId = row id', async () => {
    const created = { ...EXISTING, id: 'job-new-1', idempotencyKey: 'op-456' };
    const { service, bullmq, prisma } = makeMocks(null);
    prisma.queueJob.create = jest.fn(async () => created) as never;
    const result = await service.enqueue({
      jobType: 'test.echo',
      payload: { b: 2 },
      idempotencyKey: 'op-456',
    });
    expect(result.id).toBe('job-new-1');
    expect(bullmq.add).toHaveBeenCalledWith(created, 0);
  });

  it('a lost idempotency race (P2002) returns the winner', async () => {
    const { service, bullmq, prisma } = makeMocks(EXISTING, true);
    // corr-06: no pre-check — the first (and only) findFirst is the
    // post-P2002 re-fetch of the winning row.
    prisma.queueJob.findFirst = jest.fn().mockResolvedValue(EXISTING);

    const result = await service.enqueue({
      jobType: 'test.echo',
      payload: { a: 1 },
      idempotencyKey: 'op-123',
    });
    expect(result.id).toBe('job-existing-1');
    expect(bullmq.add).not.toHaveBeenCalled();
    expect(prisma.queueJob.findFirst).toHaveBeenCalledTimes(1);
  });

  it('a delayed enqueue persists as SCHEDULED and adds with delay', async () => {
    const created = { ...EXISTING, id: 'job-new-2', status: 'SCHEDULED', idempotencyKey: null };
    const { service, bullmq, prisma } = makeMocks(null);
    prisma.queueJob.create = jest.fn(async () => created) as never;
    await service.enqueue({ jobType: 'workflow.timer', payload: {}, delayMs: 60_000 });
    expect(bullmq.add).toHaveBeenCalledWith(created, 60_000);
    expect(prisma.queueJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SCHEDULED' }),
      }),
    );
  });

  // ── mini-07: queue-idempotency-company-scope ──

  it('mini-07: same key, two different companies → two jobs', async () => {
    const jobA = { ...EXISTING, id: 'job-company-A', companyId: 'company-A' };
    const jobB = { ...EXISTING, id: 'job-company-B', companyId: 'company-B' };
    const bullmq = { add: jest.fn(async () => true), removeJob: jest.fn() };
    const rows: Array<Record<string, any>> = [jobA, jobB];
    const prisma = {
      queueJob: {
        findFirst: jest.fn(
          async (args: { where: { companyId?: string | null; idempotencyKey?: string } }) =>
            rows.find(
              (r) =>
                r.idempotencyKey === args.where.idempotencyKey &&
                (r.companyId ?? null) === (args.where.companyId ?? null),
            ) ?? null,
        ),
        create: jest.fn(async (args: { data: Record<string, unknown> }) => {
          const row = {
            ...EXISTING,
            id: `job-${args.data.companyId}`,
            ...args.data,
          };
          rows.push(row);
          return row;
        }),
      },
    };
    const service = new QueueService(prisma as never, new QueueHandlerRegistry(), bullmq as never);

    const first = await service.enqueue({
      jobType: 'test.echo',
      payload: {},
      companyId: 'company-A',
      idempotencyKey: 'shared-key',
    });
    const second = await service.enqueue({
      jobType: 'test.echo',
      payload: {},
      companyId: 'company-B',
      idempotencyKey: 'shared-key',
    });

    expect(first.id).toBe('job-company-A');
    expect(second.id).toBe('job-company-B');
    expect(second.id).not.toBe(first.id);
    expect(prisma.queueJob.create).toHaveBeenCalledTimes(2);
  });

  it('mini-07: same company, same key → same job returned (no second row)', async () => {
    const jobA = { ...EXISTING, id: 'job-company-A', companyId: 'company-A', idempotencyKey: 'shared-key' };
    const bullmq = { add: jest.fn(async () => true), removeJob: jest.fn() };
    const prisma = {
      queueJob: {
        findFirst: jest.fn(
          async (args: { where: { companyId?: string | null; idempotencyKey?: string } }) =>
            jobA.idempotencyKey === args.where.idempotencyKey &&
            (jobA.companyId ?? null) === (args.where.companyId ?? null)
              ? jobA
              : null,
        ),
        // corr-06: insert-first — the second insert loses the race (P2002).
        create: jest.fn(async () => {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }),
      },
    };
    const service = new QueueService(prisma as never, new QueueHandlerRegistry(), bullmq as never);

    const first = await service.enqueue({
      jobType: 'test.echo',
      payload: {},
      companyId: 'company-A',
      idempotencyKey: 'shared-key',
    });
    const second = await service.enqueue({
      jobType: 'test.echo',
      payload: {},
      companyId: 'company-A',
      idempotencyKey: 'shared-key',
    });

    expect(first.id).toBe('job-company-A');
    expect(second.id).toBe('job-company-A');
    expect(bullmq.add).not.toHaveBeenCalled();
  });

  it('corr-06: platform (null company) dedupe is DB-enforced via the partial unique index', async () => {
    // The insert runs (no pre-check), hits queue_jobs_platform_idempotency_uniq
    // (P2002) and resolves to the existing platform row.
    const { service, prisma, bullmq } = makeMocks(EXISTING, true);
    const result = await service.enqueue({
      jobType: 'test.echo',
      payload: {},
      idempotencyKey: 'op-123',
      // no companyId → platform job
    });

    expect(result.id).toBe('job-existing-1');
    expect(prisma.queueJob.create).toHaveBeenCalledTimes(1);
    expect(prisma.queueJob.findFirst).toHaveBeenCalledWith({
      where: { companyId: null, idempotencyKey: 'op-123' },
    });
    expect(bullmq.add).not.toHaveBeenCalled();
  });
});
