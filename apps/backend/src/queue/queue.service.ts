import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma, QueueJob, QueueJobStatus, QueuePriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueHandlerRegistry } from './queue.handlers';
import { QueueBullmqService } from './queue-bullmq.service';
import { Paginated } from '../common/dto/pagination.dto';
import { NotFoundError, ValidationError } from '../common/errors';

export interface EnqueueJobInput {
  jobType: string;
  payload: unknown;
  companyId?: string | null;
  queueName?: string;
  priority?: QueuePriority;
  maxAttempts?: number;
  delayMs?: number;
  idempotencyKey?: string;
  createdBy?: string;
}

export interface QueueJobListQuery {
  companyId?: string | null;
  status?: QueueJobStatus;
  jobType?: string;
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

/**
 * Hybrid queue service:
 *   1. persist a QueueJob row (durable history, status, idempotency), then
 *   2. hand execution to BullMQ/Redis when available (jobId = row id,
 *      delay, priority, attempts, custom backoff).
 * When BullMQ is unavailable the DB-polling WorkerService picks the row up.
 */
@Injectable()
export class QueueService {
  private readonly logger = new Logger('QueueService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: QueueHandlerRegistry,
    private readonly bullmq: QueueBullmqService,
  ) {}

  /**
   * Enqueue a job. When `idempotencyKey` is supplied and already known, the
   * existing job is returned unchanged — no second BullMQ job is added
   * (idempotency keys on automation/queue paths, REQUIREMENTS §70-71).
   */
  async enqueue(input: EnqueueJobInput): Promise<QueueJob> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.queueJob.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;
    }

    const delayMs = input.delayMs ?? 0;
    const status: QueueJobStatus = delayMs > 0 ? 'SCHEDULED' : 'PENDING';
    let row: QueueJob;
    try {
      row = await this.prisma.queueJob.create({
        data: {
          jobType: input.jobType,
          payload: toJson(input.payload),
          companyId: input.companyId ?? null,
          queueName: input.queueName ?? 'default',
          priority: input.priority ?? 'NORMAL',
          maxAttempts: input.maxAttempts ?? 5,
          status,
          scheduledAt: new Date(Date.now() + delayMs),
          idempotencyKey: input.idempotencyKey,
          createdBy: input.createdBy,
        },
      });
    } catch (error) {
      // Lost the idempotency race — return the winner.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        input.idempotencyKey
      ) {
        const existing = await this.prisma.queueJob.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
        });
        if (existing) return existing;
      }
      throw error;
    }

    if (await this.bullmq.add(row, delayMs)) {
      this.logger.debug(`Job ${row.id} (${row.jobType}) handed to BullMQ`);
    } else {
      this.logger.debug(`Job ${row.id} (${row.jobType}) queued for DB polling`);
    }
    return row;
  }

  handlerFor(jobType: string) {
    return this.registry.handlerFor(jobType);
  }

  async list(query: QueueJobListQuery): Promise<Paginated<QueueJob & { executionsCount: number }>> {
    const where: Prisma.QueueJobWhereInput = {
      companyId: query.companyId,
      status: query.status,
      jobType: query.jobType,
    };
    const [items, total] = await Promise.all([
      this.prisma.queueJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: query.skip,
        take: query.take,
        include: { _count: { select: { executions: true } } },
      }),
      this.prisma.queueJob.count({ where }),
    ]);
    return {
      items: items.map(({ _count, ...item }) => ({
        ...item,
        executionsCount: _count.executions,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Re-queue a terminal job (FAILED/CANCELLED): PENDING again, due now. */
  async retry(id: string): Promise<QueueJob> {
    const job = await this.prisma.queueJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError('Job not found', { id });
    if (job.status !== 'FAILED' && job.status !== 'CANCELLED') {
      throw new ValidationError('Only FAILED or CANCELLED jobs can be retried', {
        status: job.status,
      });
    }
    // Attempt history fields (attemptCount, lastError) are intentionally kept.
    const updated = await this.prisma.queueJob.update({
      where: { id },
      data: { status: 'PENDING', scheduledAt: new Date(), startedAt: null, finishedAt: null },
    });
    await this.bullmq.add(updated, 0);
    return updated;
  }

  async cancel(id: string): Promise<QueueJob> {
    const job = await this.prisma.queueJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError('Job not found', { id });
    const cancellable: QueueJobStatus[] = ['PENDING', 'RETRYING', 'SCHEDULED'];
    if (!cancellable.includes(job.status)) {
      throw new ValidationError('Only PENDING, SCHEDULED or RETRYING jobs can be cancelled', {
        status: job.status,
      });
    }
    await this.bullmq.removeJob(job.queueName, job.id);
    return this.prisma.queueJob.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }
}
