import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Worker } from 'bullmq';
import { AppConfig, CONFIG } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { QueueBullmqService, DEFAULT_QUEUE_NAME } from './queue-bullmq.service';
import { QueueHandlerRegistry } from './queue.handlers';

/**
 * BullMQ worker: executes jobs pushed by QueueService.enqueue.
 *
 * On every attempt it marks the QueueJob row PROCESSING, appends a
 * JobExecution history row, runs the registered handler and records the
 * outcome. BullMQ retries re-run the processor with the SAME jobId, so each
 * retry gets its own execution row (attempt_no = attemptsMade + 1). When the
 * final attempt fails the row is dead-lettered (FAILED).
 */
@Injectable()
export class QueueBullmqWorker implements OnModuleDestroy {
  private readonly logger = new Logger('QueueBullmqWorker');
  private worker: Worker | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bullmq: QueueBullmqService,
    private readonly registry: QueueHandlerRegistry,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /** Start the worker; returns false when BullMQ/Redis is not usable. */
  async start(queueName = DEFAULT_QUEUE_NAME): Promise<boolean> {
    if (this.worker) return true;
    if (!(await this.bullmq.isAvailable())) return false;

    this.worker = new Worker(
      queueName,
      async (job) => {
        await this.process(job.id as string, job.attemptsMade, job.opts.attempts ?? 1);
      },
      { connection: this.bullmq.getConnection()! },
    );
    this.logger.log(`BullMQ worker started on queue "${queueName}"`);
    return true;
  }

  /**
   * Execute one attempt for the durable row. Public for tests.
   * `attemptsMade` is 0-based before this attempt (BullMQ semantics).
   */
  async process(bullJobId: string, attemptsMade: number, attempts: number): Promise<void> {
    const row = await this.prisma.queueJob.findUnique({ where: { id: bullJobId } });
    if (!row || row.status === 'CANCELLED' || row.status === 'SUCCEEDED') return;

    const attemptNo = attemptsMade + 1;
    const startedAt = new Date();
    await this.prisma.$transaction([
      this.prisma.queueJob.update({
        where: { id: row.id },
        data: { status: 'PROCESSING', startedAt, attemptCount: attemptNo },
      }),
      this.prisma.jobExecution.create({
        data: { jobId: row.id, attemptNo, status: 'PROCESSING', startedAt },
      }),
    ]);

    const handler = this.registry.handlerFor(row.jobType);
    try {
      if (!handler) {
        throw new Error(`No handler registered for job type "${row.jobType}"`);
      }
      await handler.handle(row.payload);
      await this.prisma.$transaction([
        this.prisma.queueJob.update({
          where: { id: row.id },
          data: { status: 'SUCCEEDED', finishedAt: new Date() },
        }),
        this.prisma.jobExecution.update({
          where: { jobId_attemptNo: { jobId: row.id, attemptNo } },
          data: { status: 'SUCCEEDED', finishedAt: new Date() },
        }),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const exhausted = attemptNo >= attempts;
      await this.prisma.$transaction([
        this.prisma.jobExecution.update({
          where: { jobId_attemptNo: { jobId: row.id, attemptNo } },
          data: { status: 'FAILED', finishedAt: new Date(), error: message },
        }),
        this.prisma.queueJob.update({
          where: { id: row.id },
          data: exhausted
            ? { status: 'FAILED', finishedAt: new Date(), lastError: message }
            : { status: 'RETRYING', lastError: message },
        }),
      ]);
      // Throw so BullMQ schedules the retry / dead-letter on its side.
      throw error;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}
