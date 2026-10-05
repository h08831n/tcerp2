import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { QueueJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from './queue.service';
import { calcBackoffDelay, QueueHandlerRegistry } from './queue.handlers';

const POLL_INTERVAL_MS = 2_000;

/**
 * DB-polling queue worker (REQUIREMENTS §70–71) — the fallback runtime when
 * BullMQ/Redis is unavailable or QUEUE_DRIVER=db. Started/stopped by the
 * QueueWorkerManager, never self-starting.
 *
 * Every POLL_INTERVAL_MS it claims exactly one due job (PENDING/RETRYING,
 * scheduled_at <= now) using `SELECT … FOR UPDATE SKIP LOCKED` so multiple
 * workers can safely share the queue. Priority order: CRITICAL > HIGH >
 * NORMAL > LOW, oldest scheduled first.
 */
@Injectable()
export class WorkerService implements OnModuleDestroy {
  private readonly logger = new Logger('QueueWorker');
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueService: QueueService,
    private readonly registry: QueueHandlerRegistry,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
    this.logger.log(
      `Queue DB-polling worker started (interval=${POLL_INTERVAL_MS}ms, handlers=${this.registry.types().join(',')})`,
    );
  }

  onModuleDestroy(): void {
    this.stop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      let job = await this.claimNext();
      // Drain greedily: if work is available keep going instead of waiting
      // for the next tick, but never starve the event loop.
      while (job && !this.stopped) {
        await this.process(job);
        job = await this.claimNext();
      }
    } catch (error) {
      this.logger.error(
        `Worker tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Claim one due job and mark it PROCESSING (transactional, SKIP LOCKED). */
  async claimNext(): Promise<QueueJob | null> {
    return this.prisma.$transaction(async (trx) => {
      const claimed = await trx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "queue_jobs"
        WHERE "status" IN ('PENDING', 'RETRYING') AND "scheduled_at" <= now()
        ORDER BY
          CASE "priority"
            WHEN 'CRITICAL' THEN 0
            WHEN 'HIGH' THEN 1
            WHEN 'NORMAL' THEN 2
            ELSE 3
          END,
          "scheduled_at"
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      if (claimed.length === 0) return null;
      return trx.queueJob.update({
        where: { id: claimed[0].id },
        data: {
          status: 'PROCESSING',
          startedAt: new Date(),
          attemptCount: { increment: 1 },
        },
      });
    });
  }

  /** Execute a claimed job and record success / schedule retry / dead-letter. */
  async process(job: QueueJob): Promise<void> {
    const handler = this.queueService.handlerFor(job.jobType);
    try {
      if (!handler) {
        throw new Error(`No handler registered for job type "${job.jobType}"`);
      }
      await handler.handle(job.payload);
      await this.prisma.queueJob.update({
        where: { id: job.id },
        data: { status: 'SUCCEEDED', finishedAt: new Date() },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (job.attemptCount < job.maxAttempts) {
        const backoffSeconds = calcBackoffDelay(job.attemptCount);
        await this.prisma.queueJob.update({
          where: { id: job.id },
          data: {
            status: 'RETRYING',
            scheduledAt: new Date(Date.now() + backoffSeconds * 1000),
            lastError: message,
          },
        });
        this.logger.warn(
          `Job ${job.id} (${job.jobType}) attempt ${job.attemptCount}/${job.maxAttempts} failed, retrying in ${backoffSeconds}s: ${message}`,
        );
      } else {
        // Dead letter: terminal FAILED with the last error retained.
        await this.prisma.queueJob.update({
          where: { id: job.id },
          data: { status: 'FAILED', finishedAt: new Date(), lastError: message },
        });
        this.logger.error(`Job ${job.id} (${job.jobType}) dead-lettered after ${job.attemptCount} attempts: ${message}`);
      }
    }
  }
}
