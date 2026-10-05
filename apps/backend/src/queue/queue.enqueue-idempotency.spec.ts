import { QueueService } from './queue.service';
import { QueueHandlerRegistry } from './queue.handlers';

/**
 * Extra gate coverage — enqueue idempotency with the BullMQ producer mocked:
 * an existing idempotencyKey returns the SAME durable job id and never adds a
 * second BullMQ job.
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
        findUnique: jest.fn(async (args: { where: { idempotencyKey?: string } }) =>
          args.where.idempotencyKey === 'op-123' ? existing : null,
        ),
        create: jest.fn(async () => {
          if (createThrows) {
            const err = new Error('unique violation') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          return EXISTING;
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

  it('returns the existing job unchanged and does not touch BullMQ', async () => {
    const { service, bullmq, prisma } = makeMocks(EXISTING);
    const result = await service.enqueue({
      jobType: 'test.echo',
      payload: { a: 1 },
      idempotencyKey: 'op-123',
    });
    expect(result.id).toBe('job-existing-1');
    expect(prisma.queueJob.create).not.toHaveBeenCalled();
    expect(bullmq.add).not.toHaveBeenCalled();
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
    const { service, bullmq } = makeMocks(EXISTING, true);
    const result = await service.enqueue({
      jobType: 'test.echo',
      payload: { a: 1 },
      idempotencyKey: 'op-123',
    });
    expect(result.id).toBe('job-existing-1');
    expect(bullmq.add).not.toHaveBeenCalled();
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
});
