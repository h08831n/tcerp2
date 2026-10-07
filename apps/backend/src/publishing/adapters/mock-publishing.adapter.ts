import { PublishChannel } from '@prisma/client';
import {
  PublishingAdapter,
  PublishingAdapterConfig,
  PublishSendResult,
  RenderedPublishPayload,
} from '../publishing-adapter';

/**
 * Mock publishing adapter (Phase 5): ALL channels are mock-backed. Behaviour
 * is driven by the IntegrationConfig.config:
 *   { mode: 'mock', forceFail?: boolean, failFirst?: number }
 *   - forceFail  → always fails (providerResponse carries MOCK_FORCE_FAIL);
 *   - failFirst  → fails the first N sends PER DESTINATION, then succeeds
 *                  (per-process in-memory counter — deterministic in tests).
 * Every SUCCESSFUL send is recorded on `sent` so tests can assert
 * "one send per successful item" (no double sends).
 */
export class MockPublishingAdapter implements PublishingAdapter {
  readonly channel: PublishChannel;
  readonly sent: {
    channel: PublishChannel;
    destination: string | null;
    messageText: string;
    variantIds: string[];
    at: Date;
  }[] = [];

  private readonly failCounts = new Map<string, number>();

  constructor(channel: PublishChannel) {
    this.channel = channel;
  }

  async send(
    rendered: RenderedPublishPayload,
    config: PublishingAdapterConfig = {},
    destination?: string | null,
  ): Promise<PublishSendResult> {
    const destinationKey = destination ?? '';
    const failures = this.failCounts.get(destinationKey) ?? 0;

    if (config.forceFail === true) {
      return {
        ok: false,
        providerResponse: {
          provider: 'mock',
          channel: this.channel,
          error: 'MOCK_FORCE_FAIL',
          forced: true,
        },
      };
    }
    if (typeof config.failFirst === 'number' && failures < config.failFirst) {
      this.failCounts.set(destinationKey, failures + 1);
      return {
        ok: false,
        providerResponse: {
          provider: 'mock',
          channel: this.channel,
          error: 'MOCK_FAIL_FIRST',
          attempt: failures + 1,
        },
      };
    }

    this.sent.push({
      channel: this.channel,
      destination: destination ?? null,
      messageText: rendered.messageText,
      variantIds: rendered.variantIds,
      at: new Date(),
    });
    return {
      ok: true,
      providerResponse: {
        provider: 'mock',
        channel: this.channel,
        mode: config.mode ?? 'mock',
        messageId: `mock-${this.channel.toLowerCase()}-${Date.now()}`,
        characters: rendered.messageText.length,
      },
    };
  }
}

/** Named per-channel mock providers — real HTTP impls replace these later. */
export class WebsiteMockProvider extends MockPublishingAdapter {
  constructor() {
    super('WEBSITE');
  }
}
export class TelegramMockProvider extends MockPublishingAdapter {
  constructor() {
    super('TELEGRAM');
  }
}
export class WhatsappMockProvider extends MockPublishingAdapter {
  constructor() {
    super('WHATSAPP');
  }
}
export class EitaaMockProvider extends MockPublishingAdapter {
  constructor() {
    super('EITAA');
  }
}
export class BaleMockProvider extends MockPublishingAdapter {
  constructor() {
    super('BALE');
  }
}
export class RubikaMockProvider extends MockPublishingAdapter {
  constructor() {
    super('RUBIKA');
  }
}
export class SmsMockProvider extends MockPublishingAdapter {
  constructor() {
    super('SMS');
  }
}

/** Fresh adapter set (one per PublishChannel) for DI and test fixtures. */
export function defaultPublishingAdapters(): PublishingAdapter[] {
  return [
    new WebsiteMockProvider(),
    new TelegramMockProvider(),
    new WhatsappMockProvider(),
    new EitaaMockProvider(),
    new BaleMockProvider(),
    new RubikaMockProvider(),
    new SmsMockProvider(),
  ];
}
