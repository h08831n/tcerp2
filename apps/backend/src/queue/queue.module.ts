import { Module } from '@nestjs/common';
import { QueueController } from './queue.controller';
import { QueueService } from './queue.service';
import { WorkerService } from './worker.service';
import { QUEUE_HANDLERS, testEchoHandler } from './queue.handlers';

@Module({
  controllers: [QueueController],
  providers: [
    QueueService,
    WorkerService,
    {
      provide: QUEUE_HANDLERS,
      useValue: [testEchoHandler],
    },
  ],
  exports: [QueueService, QUEUE_HANDLERS],
})
export class QueueModule {}
