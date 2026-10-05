import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/configuration';
import { QueueBullmqService } from './queue-bullmq.service';
import { QueueBullmqWorker } from './queue-bullmq.worker';
import { WorkerService } from './worker.service';

/**
 * Chooses the queue runtime driver at boot (REQUIREMENTS correction gate):
 *   QUEUE_DRIVER=auto (default) — try BullMQ/Redis; on failure fall back to
 *     DB polling with a one-time warning.
 *   QUEUE_DRIVER=bullmq — BullMQ only (error when Redis is unreachable).
 *   QUEUE_DRIVER=db — DB polling only.
 */
@Injectable()
export class QueueWorkerManager implements OnApplicationBootstrap {
  private readonly logger = new Logger('QueueDriver');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly bullmq: QueueBullmqService,
    private readonly bullmqWorker: QueueBullmqWorker,
    private readonly dbWorker: WorkerService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.NODE_ENV === 'test') {
      this.logger.log('Queue workers disabled (NODE_ENV=test)');
      return;
    }

    const driver = this.config.QUEUE_DRIVER;
    if (driver === 'db') {
      this.dbWorker.start();
      return;
    }

    if (await this.bullmqWorker.start()) {
      this.logger.log('Queue driver: bullmq');
      return;
    }
    if (driver === 'bullmq') {
      this.logger.error('QUEUE_DRIVER=bullmq but Redis is unreachable');
      return;
    }
    this.logger.warn('Redis unavailable — falling back to DB-polling queue driver');
    this.dbWorker.start();
  }
}
