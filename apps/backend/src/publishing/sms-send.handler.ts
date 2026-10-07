import { Inject, Injectable, Logger } from '@nestjs/common';
import { PublishChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueHandler } from '../queue/queue.handlers';
import {
  PUBLISHING_ADAPTERS,
  PublishingAdapter,
  PublishingAdapterConfig,
  RenderedPublishPayload,
  adapterMapOf,
} from './publishing-adapter';

/**
 * Queue handler `sms.send` (Phase 5 mock bridge; REQUIREMENTS §54 full SMS
 * engine — send logs, manual resend, provider fallback — lands in a later
 * phase, see README). Payload: {companyId, to, text}. Resolves the company's
 * active SMS IntegrationConfig and sends through the SMS channel adapter
 * (mock today). A missing config fails the job with NO_ADAPTER_CONFIG so it
 * surfaces in the queue error center.
 */
@Injectable()
export class SmsSendHandler implements QueueHandler {
  readonly type = 'sms.send';
  private readonly logger = new Logger('SmsSendHandler');
  private adapterMap: Map<PublishChannel, PublishingAdapter> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PUBLISHING_ADAPTERS) private readonly adapters: PublishingAdapter[],
  ) {}

  private mapAdapters(): Map<PublishChannel, PublishingAdapter> {
    if (!this.adapterMap) this.adapterMap = adapterMapOf(this.adapters);
    return this.adapterMap;
  }

  async handle(payload: unknown): Promise<void> {
    const input = (payload ?? {}) as { companyId?: string; to?: string; text?: string };
    if (!input.companyId || !input.to || !input.text) return;

    const config = await this.prisma.integrationConfig.findFirst({
      where: { companyId: input.companyId, type: 'SMS', isActive: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (!config) {
      throw new Error('NO_ADAPTER_CONFIG');
    }
    const adapter = this.mapAdapters().get('SMS');
    if (!adapter) throw new Error('NO_ADAPTER');

    const rendered: RenderedPublishPayload = {
      messageText: input.text,
      lines: [],
      variantIds: [],
    };
    const result = await adapter.send(
      rendered,
      (config.config ?? {}) as PublishingAdapterConfig,
      input.to,
    );
    if (!result.ok) {
      throw new Error(String(result.providerResponse.error ?? 'SMS_PROVIDER_FAILED'));
    }
    this.logger.debug(`SMS (mock) sent to ${input.to}`);
  }
}
