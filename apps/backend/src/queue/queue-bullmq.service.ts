import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { QueueJob } from '@prisma/client';
import IORedis from 'ioredis';
import { Queue as BullQueue } from 'bullmq';
import { AppConfig, CONFIG } from '../config/configuration';
import { bullmqBackoffStrategy, priorityToBull } from './queue.handlers';

export const DEFAULT_QUEUE_NAME = 'default';

/**
 * BullMQ/Redis runtime side of the hybrid queue architecture:
 * PostgreSQL (QueueJob/JobExecution) is the durable source of truth for
 * history/status/idempotency; BullMQ owns runtime scheduling, delays and
 * retries. This service owns the Redis connection and producer Queues.
 */
@Injectable()
export class QueueBullmqService implements OnModuleDestroy {
  private readonly logger = new Logger('QueueBullmq');
  private connection: IORedis | null = null;
  private readonly queues = new Map<string, BullQueue>();
  private availabilityKnown = false;
  private available = false;

  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}  /** Shared Redis connection (null when REDIS_URL is not configured). */
  getConnection(): IORedis | null {
    if (!this.config.REDIS_URL) return null;
    if (!this.connection) {
      this.connection = new IORedis(this.config.REDIS_URL, {
        maxRetriesPerRequest: null,
        lazyConnect: true,
      });
    }
    return this.connection;
  }

  /**
   * Probe Redis once; the result is cached for the process lifetime so a
   * transient outage does not flip-flop the driver mid-run.
   */
  async isAvailable(): Promise<boolean> {
    if (this.availabilityKnown) return this.available;
    const connection = this.getConnection();
    if (!connection) {
      this.availabilityKnown = true;
      this.available = false;
      return false;
    }
    try {
      if (connection.status === 'wait') connection.connect();
      const pong = await Promise.race([
        connection.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('redis ping timeout')), 2000),
        ),
      ]);
      this.available = pong === 'PONG';
    } catch (error) {
      this.available = false;
      this.logger.warn(
        `Redis unavailable (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    this.availabilityKnown = true;
    return this.available;
  }

  /**
   * Add a BullMQ job for a persisted QueueJob row. `jobId` = row id so
   * BullMQ retries map back to the same durable row. Returns false when
   * BullMQ is not usable (caller keeps the DB-polling path).
   */
  async add(row: QueueJob, delayMs: number): Promise<boolean> {
    if (!(await this.isAvailable())) return false;
    const queue = this.getQueue(row.queueName || DEFAULT_QUEUE_NAME);
    await queue.add(
      row.jobType,
      row.payload,
      {
        jobId: row.id,
        delay: Math.max(delayMs, 0),
        priority: priorityToBull(row.priority),
        attempts: row.maxAttempts,
        backoff: { type: 'custom' },
        removeOnComplete: { age: 24 * 3600, count: 5000 },
        removeOnFail: { age: 24 * 3600, count: 5000 },
      },
    );
    return true;
  }

  /** Best-effort removal of a pending BullMQ job (e.g. on cancel). */
  async removeJob(queueName: string, jobId: string): Promise<void> {
    if (!this.availabilityKnown || !this.available) return;
    try {
      const queue = this.queues.get(queueName || DEFAULT_QUEUE_NAME);
      if (queue) {
        const job = await queue.getJob(jobId);
        if (job) await job.remove();
      }
    } catch (error) {
      this.logger.warn(
        `Failed to remove BullMQ job ${jobId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  getQueue(queueName: string): BullQueue {
    let queue = this.queues.get(queueName);
    if (!queue) {
      const connection = this.getConnection();
      if (!connection) throw new Error('REDIS_URL is not configured');
      queue = new BullQueue(queueName, {
        connection,
        settings: {
          // Custom backoff: same curve as the DB-polling fallback.
          // (Runtime-supported; not yet in the public QueueOptions typing.)
          backoffStrategy: (attemptsMade: number) => bullmqBackoffStrategy(attemptsMade),
        },
      } as unknown as ConstructorParameters<typeof BullQueue>[1]);
      this.queues.set(queueName, queue);
    }
    return queue;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    if (this.connection) {
      this.connection.disconnect();
      this.connection = null;
    }
  }
}
