import { Module, OnModuleInit } from '@nestjs/common';
import { AutomationController } from './automation.controller';
import { AutomationRuleService } from './automation-rule.service';
import { AutomationService } from './automation.service';
import { AutomationRunHandler, DailyScanHandler } from './automation.handlers';
import { AutomationScheduler } from './automation.scheduler';
import { PublishingModule } from '../publishing/publishing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { ActivitiesModule } from '../activities/activities.module';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

/**
 * Automation engine (Phase 5 + Phase 9C): rules + runs + event/daily-scan
 * execution, bounded durable retry, execution delays, dry-run validation and
 * the REAL CREATE_ACTIVITY action (Phase 9A engine). Depends on
 * PublishingModule (PUBLISH_PRICE auto-batches), NotificationsModule
 * (in-app notifications) and ActivitiesModule (CREATE_ACTIVITY);
 * QueueModule/AuditModule are global.
 */
@Module({
  imports: [PublishingModule, NotificationsModule, ActivitiesModule],
  controllers: [AutomationController],
  providers: [AutomationRuleService, AutomationService, AutomationRunHandler, DailyScanHandler, AutomationScheduler],
  exports: [AutomationService],
})
export class AutomationModule implements OnModuleInit {
  constructor(
    private readonly registry: QueueHandlerRegistry,
    private readonly runHandler: AutomationRunHandler,
    private readonly scanHandler: DailyScanHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.runHandler);
    this.registry.register(this.scanHandler);
  }
}
