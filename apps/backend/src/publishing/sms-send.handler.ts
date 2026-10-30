import { Inject, Injectable, Logger } from '@nestjs/common';
import { PublishChannel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QueueHandler } from '../queue/queue.handlers';
import { settleSmsMessage } from '../notifications/sms.service';
import {
  PUBLISHING_ADAPTERS,
  PublishingAdapter,
  PublishingAdapterConfig,
  RenderedPublishPayload,
  adapterMapOf,
} from './publishing-adapter';

/**
 * Queue handler `sms.send`. Phase 9D contract: the payload carries
 * `{smsMessageId}` — the durable SmsMessage row (created at ENQUEUE time)
 * is the authority for company/to/text AND the delivery log (the handler
 * flips it to SENT / FAILED + provider response; queue-level retries
 * re-drive the SAME row). The legacy inline payload `{companyId, to, text}`
 * (automation pre-9D) still sends but has no log row. A missing SMS
 * IntegrationConfig fails the job with NO_ADAPTER_CONFIG so it surfaces in
 * the queue error center — for logged messages the row lands on FAILED.
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
    const input = (payload ?? {}) as {
      smsMessageId?: string;
      companyId?: string;
      to?: string;
      text?: string;
    };

    // ── Phase 9D logged path ──
    if (typeof input.smsMessageId === 'string' && input.smsMessageId) {
      const message = await this.prisma.smsMessage.findUnique({
        where: { id: input.smsMessageId },
      });
      if (!message) return; // row gone — nothing to deliver or log
      try {
        await this.deliver(message.companyId, message.to, message.text);
        await settleSmsMessage(this.prisma, message.id, { ok: true });
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        await settleSmsMessage(this.prisma, message.id, {
          ok: false,
          error: text,
          providerResponse: { error: text },
        });
        throw error; // surface for the queue retry (maxAttempts 3)
      }
      return;
    }

    // ── Legacy inline path (no log row) ──
    if (!input.companyId || !input.to || !input.text) return;
    await this.deliver(input.companyId, input.to, input.text);
  }

  private async deliver(companyId: string, to: string, text: string): Promise<void> {
    const config = await this.prisma.integrationConfig.findFirst({
      where: { companyId, type: 'SMS', isActive: true },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    if (!config) {
      throw new Error('NO_ADAPTER_CONFIG');
    }
    const adapter = this.mapAdapters().get('SMS');
    if (!adapter) throw new Error('NO_ADAPTER');

    const rendered: RenderedPublishPayload = {
      messageText: text,
      lines: [],
      variantIds: [],
    };
    const result = await adapter.send(
      rendered,
      (config.config ?? {}) as PublishingAdapterConfig,
      to,
    );
    if (!result.ok) {
      throw new Error(String(result.providerResponse.error ?? 'SMS_PROVIDER_FAILED'));
    }
    this.logger.debug(`SMS sent to ${to}`);
  }
}
