import { Global, Module } from '@nestjs/common';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { QueueHandlerRegistry, QueueHandler, testEchoHandler } from './queue.handlers';
import { QueueBullmqService } from './queue-bullmq.service';
import { QueueBullmqWorker } from './queue-bullmq.worker';
import { WorkerService } from './worker.service';
import { QueueWorkerManager } from './queue-worker.manager';

/**
 * Global: business modules inject QueueService (enqueue from any service)
 * and register QueueHandlers on the registry without importing this module.
 */
@Global()
@Module({
  controllers: [QueueController],
  providers: [
    QueueService,
    QueueBullmqService,
    QueueBullmqWorker,
    WorkerService,
    QueueWorkerManager,
    {
      provide: QueueHandlerRegistry,
      useFactory: () => {
        const registry = new QueueHandlerRegistry();
        registry.register(testEchoHandler);
        return registry;
      },
    },
  ],
  exports: [QueueService, QueueHandlerRegistry],
})
export class QueueModule {}

/** Convenience for modules that contribute a handler. */
export type { QueueHandler };
