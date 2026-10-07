import { PublishChannel } from '@prisma/client';

/**
 * Publishing adapter contract (REQUIREMENTS §72 Integration Platform):
 * business modules never call a vendor SDK — they resolve a channel adapter
 * from the PUBLISHING_ADAPTERS registry. All Phase 5 adapters are mock-backed
 * (IntegrationConfig.config.mode = 'mock'); real HTTP implementations land
 * later WITHOUT service changes — only new adapter classes are registered.
 */
export const PUBLISHING_ADAPTERS = Symbol('PUBLISHING_ADAPTERS');

/** Adapter settings taken from the company's IntegrationConfig.config. */
export interface PublishingAdapterConfig {
  mode?: string;
  forceFail?: boolean;
  failFirst?: number;
  [key: string]: unknown;
}

/** Rendered payload attached to every PublishBatchItem. */
export interface RenderedPublishPayload {
  messageText: string;
  lines: {
    productTemplateId: string | null;
    product: string;
    variantId: string;
    variantSku: string;
    text: string;
  }[];
  templateId?: string | null;
  templateCode?: string | null;
  warnings?: string[];
  /** Variant ids covered by this payload (used by the website-only filter). */
  variantIds: string[];
}

export interface PublishSendResult {
  ok: boolean;
  providerResponse: Record<string, unknown>;
}

export interface PublishingAdapter {
  readonly channel: PublishChannel;
  /**
   * Send one rendered payload. Implementations return ok=false (or throw) on
   * failure — the queue handler records lastError + providerResponse either
   * way. MUST be deterministic and offline (mocks only in Phase 5).
   */
  send(
    rendered: RenderedPublishPayload,
    config: PublishingAdapterConfig,
    destination?: string | null,
  ): Promise<PublishSendResult>;
}

/** Channel → adapter lookup built from the registered adapter list. */
export function adapterMapOf(adapters: PublishingAdapter[]): Map<PublishChannel, PublishingAdapter> {
  return new Map(adapters.map((adapter) => [adapter.channel, adapter]));
}
