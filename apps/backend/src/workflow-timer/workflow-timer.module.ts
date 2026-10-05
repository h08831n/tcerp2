import { Module, OnModuleInit } from '@nestjs/common';
import { WorkflowTimerService, WorkflowTimerHandler } from './workflow-timer.service';
import { WorkflowTimerController } from './workflow-timer.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

@Module({
  imports: [NotificationsModule],
  controllers: [WorkflowTimerController],
  providers: [WorkflowTimerService, WorkflowTimerHandler],
  exports: [WorkflowTimerService],
})
export class WorkflowTimerModule implements OnModuleInit {
  constructor(
    private readonly registry: QueueHandlerRegistry,
    private readonly timerHandler: WorkflowTimerHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.timerHandler);
  }
}
