import { Module, OnModuleInit } from '@nestjs/common';
import {
  NotificationsController,
  NotificationRulesController,
} from './notifications.controller';
import {
  NotificationDispatchHandler,
  NotificationRuleService,
  NotificationService,
} from './notifications.service';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

@Module({
  controllers: [NotificationsController, NotificationRulesController],
  providers: [NotificationService, NotificationRuleService, NotificationDispatchHandler],
  exports: [NotificationService, NotificationRuleService],
})
export class NotificationsModule implements OnModuleInit {
  constructor(
    private readonly registry: QueueHandlerRegistry,
    private readonly dispatchHandler: NotificationDispatchHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.dispatchHandler);
  }
}
