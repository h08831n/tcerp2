import { Module, OnModuleInit } from '@nestjs/common';
import { PublishingController } from './publishing.controller';
import { PublishingService, PublishBatchItemHandler } from './publishing.service';
import { PublishingTemplateService } from './publishing-template.service';
import { SmsSendHandler } from './sms-send.handler';
import { defaultPublishingAdapters } from './adapters/mock-publishing.adapter';
import { PUBLISHING_ADAPTERS } from './publishing-adapter';
import { QueueHandlerRegistry } from '../queue/queue.handlers';

/**
 * Publishing engine (Phase 5): batch fan-out, per-channel queue items,
 * mock channel adapters + templates. QueueModule/AuditModule/SequencesModule
 * are global — only the adapter registry is provided here.
 */
@Module({
  controllers: [PublishingController],
  providers: [
    PublishingService,
    PublishingTemplateService,
    PublishBatchItemHandler,
    SmsSendHandler,
    { provide: PUBLISHING_ADAPTERS, useFactory: defaultPublishingAdapters },
  ],
  exports: [PublishingService, PublishingTemplateService],
})
export class PublishingModule implements OnModuleInit {
  constructor(
    private readonly registry: QueueHandlerRegistry,
    private readonly itemHandler: PublishBatchItemHandler,
    private readonly smsHandler: SmsSendHandler,
  ) {}

  onModuleInit(): void {
    this.registry.register(this.itemHandler);
    this.registry.register(this.smsHandler);
  }
}
