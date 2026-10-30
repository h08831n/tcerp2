import { Module, OnModuleInit } from '@nestjs/common';
import {
  NotificationsController,
  NotificationRulesController,
  SmsController,
  SmsTemplatesController,
} from './notifications.controller';
import {
  NotificationDispatchHandler,
  NotificationRuleService,
  NotificationService,
} from './notifications.service';
import { SmsService, SmsTemplateService } from './sms.service';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

/**
 * Notification + SMS center (Phase 9D): IN_APP rules dispatch, the durable
 * SMS send log (SmsMessage), templates, manual send/resend. The SmsService
 * is exported so AutomationModule switches its SEND_SMS action onto the
 * logged path.
 */
@Module({
  controllers: [
    NotificationsController,
    NotificationRulesController,
    SmsController,
    SmsTemplatesController,
  ],
  providers: [
    NotificationService,
    NotificationRuleService,
    NotificationDispatchHandler,
    SmsService,
    SmsTemplateService,
  ],
  exports: [NotificationService, NotificationRuleService, SmsService, SmsTemplateService],
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
