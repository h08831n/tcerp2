import { Inject, Injectable } from '@nestjs/common';
import { Prisma, QueueJob, QueueJobStatus, QueuePriority } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QUEUE_HANDLERS, QueueHandler } from './queue.handlers';
import { Paginated } from '../common/dto/pagination.dto';
import { NotFoundError, ValidationError } from '../common/errors';

export interface EnqueueJobInput {
  jobType: string;
  payload: unknown;
  priority?: QueuePriority;
  maxAttempts?: number;
  delayMs?: number;
  idempotencyKey?: string;
  createdBy?: string;
}

export class QueueJobQuery {
  status?: QueueJobStatus;
  jobType?: string;
  page = 1;
  pageSize = 20;

  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }
  get take(): number {
    return this.pageSize;
  }
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

@Injectable()
export class QueueService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(QUEUE_HANDLERS) private readonly handlers: QueueHandler[],
  ) {}

  /**
   * Enqueue a job. When `idempotencyKey` is supplied and already known, the
   * existing job is returned unchanged (REQUIREMENTS architecture: idempotency
   * keys on automation/queue paths).
   */
  async enqueue(input: EnqueueJobInput): Promise<QueueJob> {
    if (input.idempotencyKey) {
      const existing = await this.prisma.queueJob.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;
    }

    try {
      return await this.prisma.queueJob.create({
        data: {
          jobType: input.jobType,
          payload: toJson(input.payload),
          priority: input.priority ?? 'NORMAL',
          maxAttempts: input.maxAttempts ?? 5,
          scheduledAt: new Date(Date.now() + (input.delayMs ?? 0)),
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
  }

  handlerFor(jobType: string): QueueHandler | undefined {
    return this.handlers.find((h) => h.type === jobType);
  }

  async list(
    query: QueueJobQuery & { skip: number; take: number },
  ): Promise<Paginated<QueueJob>> {
    const where: Prisma.QueueJobWhereInput = {
      status: query.status,
      jobType: query.jobType,
    };
    const [items, total] = await Promise.all([
      this.prisma.queueJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: query.skip,
        take: query.take,
      }),
      this.prisma.queueJob.count({ where }),
    ]);
    return { items, total, page: query.page, pageSize: query.pageSize };
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
    return this.prisma.queueJob.update({
      where: { id },
      data: { status: 'PENDING', scheduledAt: new Date(), startedAt: null, finishedAt: null },
    });
  }

  async cancel(id: string): Promise<QueueJob> {
    const job = await this.prisma.queueJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundError('Job not found', { id });
    const cancellable: QueueJobStatus[] = ['PENDING', 'RETRYING'];
    if (!cancellable.includes(job.status)) {
      throw new ValidationError('Only PENDING or RETRYING jobs can be cancelled', {
        status: job.status,
      });
    }
    return this.prisma.queueJob.update({
      where: { id },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }
}
