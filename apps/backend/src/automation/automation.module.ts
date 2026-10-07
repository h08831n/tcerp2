import { Module, OnModuleInit } from '@nestjs/common';
import { AutomationController } from './automation.controller';
import { AutomationRuleService } from './automation-rule.service';
import { AutomationService } from './automation.service';
import { AutomationRunHandler, DailyScanHandler } from './automation.handlers';
import { AutomationScheduler } from './automation.scheduler';
import { PublishingModule } from '../publishing/publishing.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

/**
 * Automation engine (Phase 5): rules + runs + PRICE_UPDATED/daily-scan
 * execution. Depends on PublishingModule (PUBLISH_PRICE auto-batches) and
 * NotificationsModule (in-app notifications); QueueModule/AuditModule are
 * global.
 */
@Module({
  imports: [PublishingModule, NotificationsModule],
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
