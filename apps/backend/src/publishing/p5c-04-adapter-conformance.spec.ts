import { PublishChannel } from '@prisma/client';
import {
  adapterMapOf,
  PUBLISHING_ADAPTERS,
  PublishingAdapter,
  PublishingAdapterConfig,
  RenderedPublishPayload,
} from './publishing-adapter';
import { defaultPublishingAdapters, MockPublishingAdapter } from './adapters/mock-publishing.adapter';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createVariantInCompany, dailyPriceService, publishingService } from '../testing/p5-fixtures';
import { PublishBatchItemHandler } from './publishing.service';
import { todayKey } from '../pricing/day';

/**
 * p5c-04 adapter architecture contract (pricing-integrity review follow-up):
 * the publishing engine consumes ONLY the PublishingAdapter interface — a
 * real vendor implementation must be able to replace the mocks without ANY
 * change to PublishingBatch / PublishBatchItem / queue / automation code.
 *
 * Pure conformance (channels + contract) runs everywhere; the fake-adapter
 * end-to-end proof needs the database and runs with TEST_INTEGRATION=1.
 */

const ALL_CHANNELS: PublishChannel[] = [
  'WEBSITE',
  'TELEGRAM',
  'WHATSAPP',
  'EITAA',
  'BALE',
  'RUBIKA',
  'SMS',
];

const samplePayload: RenderedPublishPayload = {
  messageText: 'میلگرد: 31250 kg',
  lines: [
    {
      productTemplateId: 't1',
      product: 'میلگرد',
      variantId: 'v1',
      variantSku: 'P5-X',
      text: 'میلگرد: 31250 kg',
    },
  ],
  variantIds: ['v1'],
};

/** A stand-in for a REAL HTTP adapter: implements ONLY the interface. */
class FakeTelegramAdapter implements PublishingAdapter {
  readonly channel: PublishChannel = 'TELEGRAM';
  readonly calls: { messageText: string; destination: string | null }[] = [];

  async send(
    rendered: RenderedPublishPayload,
    _config: PublishingAdapterConfig,
    destination?: string | null,
  ) {
    this.calls.push({ messageText: rendered.messageText, destination: destination ?? null });
    return {
      ok: true,
      providerResponse: { provider: 'fake-telegram', externalId: `tg-${this.calls.length}` },
    };
  }
}

describe('p5c-04 publishing adapter contract', () => {
  it('the default registry covers ALL 7 PublishChannel values exactly once', () => {
    const adapters = defaultPublishingAdapters();
    const map = adapterMapOf(adapters);
    expect(adapters).toHaveLength(ALL_CHANNELS.length);
    expect([...map.keys()].sort()).toEqual([...ALL_CHANNELS].sort());
  });

  it.each(defaultPublishingAdapters().map((adapter) => [adapter.channel, adapter] as const))(
    '%s adapter satisfies the PublishingAdapter contract (send → {ok, providerResponse})',
    async (_channel, adapter) => {
      expect(typeof adapter.channel).toBe('string');
      expect(typeof adapter.send).toBe('function');

      const ok = await adapter.send(samplePayload, { mode: 'mock' }, '@dest');
      expect(typeof ok.ok).toBe('boolean');
      expect(ok.ok).toBe(true);
      expect(ok.providerResponse).toBeDefined();
      expect(typeof ok.providerResponse).toBe('object');

      const failed = await adapter.send(samplePayload, { mode: 'mock', forceFail: true }, '@dest');
      expect(failed.ok).toBe(false);
      expect(failed.providerResponse.error).toBe('MOCK_FORCE_FAIL');
    },
  );

  it('MockPublishingAdapter failFirst fails N sends per destination, then succeeds', async () => {
    const adapter = new MockPublishingAdapter('TELEGRAM');
    const config: PublishingAdapterConfig = { failFirst: 2 };
    expect((await adapter.send(samplePayload, config, '@d1')).ok).toBe(false);
    expect((await adapter.send(samplePayload, config, '@d1')).ok).toBe(false);
    expect((await adapter.send(samplePayload, config, '@d1')).ok).toBe(true);
    // A DIFFERENT destination has its own counter (failFirst=2 → two fails).
    expect((await adapter.send(samplePayload, config, '@d2')).ok).toBe(false);
    // Only SUCCESSFUL sends are recorded: @d1's success so far.
    expect(adapter.sent).toHaveLength(1);
    expect(adapter.sent[0].destination).toBe('@d1');
    expect((await adapter.send(samplePayload, config, '@d2')).ok).toBe(false);
    expect((await adapter.send(samplePayload, config, '@d2')).ok).toBe(true);
    expect(adapter.sent).toHaveLength(2);
    expect(adapter.sent[1].destination).toBe('@d2');
  });

  it('PUBLISHING_ADAPTERS is a stable DI token and adapterMapOf is 1:1 by channel', () => {
    expect(typeof PUBLISHING_ADAPTERS).toBe('symbol');
    const a = new MockPublishingAdapter('SMS');
    const b = new MockPublishingAdapter('SMS');
    const map = adapterMapOf([a, b]);
    // Last registration wins per channel — the map is keyed ONLY by channel.
    expect(map.size).toBe(1);
    expect(map.get('SMS')).toBe(b);
  });
});

describeIntegration('p5c-04 fake adapter end-to-end (interface-only consumption)', () => {
  const prisma = integrationPrisma();
  const marker = `p5c-04-${Date.now()}`;
  const fake = new FakeTelegramAdapter();
  let actorId = '';
  let variantId = '';
  let templateId = '';
  let categoryId = '';
  let uomId = '';
  let configId = '';
  let templateRowId = '';
  let batchId = '';

  it('running the item handler with ONLY the fake adapter ends SUCCESS — no engine changes', async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, INTEGRATION_COMPANY_ID, marker);
    variantId = fixture.variantId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
    uomId = fixture.uomId;
    await dailyPriceService(prisma).upsert(
      INTEGRATION_COMPANY_ID,
      { productVariantId: variantId, date: todayKey(), uomId, price: 5000 },
      { id: actorId, username: 'admin' },
      {},
    );

    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p5c-04-tg-${marker}`,
        name: 'Telegram fake',
        type: 'TELEGRAM',
        isActive: true,
        config: { mode: 'real-fake' },
      },
    });
    configId = config.id;
    const template = await prisma.publishingTemplate.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        channel: 'TELEGRAM',
        code: `P5C04-${marker}`,
        nameFa: 'قالب تلگرام',
        bodyTemplate: '{product}: {price} {uom}',
      },
    });
    templateRowId = template.id;

    // The PublishingService itself is constructed with ONLY the fake adapter…
    const publish = publishingService(prisma, [fake]);
    const batch = await publish.createBatch(
      INTEGRATION_COMPANY_ID,
      {
        priceDate: todayKey(),
        channels: [{ channel: 'TELEGRAM', destination: '@fake-channel' }],
        variantIds: [variantId],
      },
      { id: actorId, username: 'admin' },
      {},
    );
    batchId = batch.batch.id;

    // …and so is the queue item handler. Engine code untouched.
    const handler = new PublishBatchItemHandler(prisma as never, [fake]);
    await handler.handle({ itemId: batch.items[0].id });

    const item = await prisma.publishBatchItem.findUniqueOrThrow({ where: { id: batch.items[0].id } });
    expect(item.status).toBe('SUCCESS');
    expect(item.lastError).toBeNull();
    expect(item.providerResponse as Record<string, unknown>).toMatchObject({ provider: 'fake-telegram' });

    const updatedBatch = await prisma.publishBatch.findUniqueOrThrow({ where: { id: batch.batch.id } });
    expect(updatedBatch.status).toBe('COMPLETED');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].destination).toBe('@fake-channel');
    expect(fake.calls[0].messageText).toContain('5000');
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: 'publish.batch_item' } });
    if (batchId) {
      await prisma.publishBatchItem.deleteMany({ where: { batchId } });
      await prisma.publishBatch.deleteMany({ where: { id: batchId } });
    }
    if (configId) await prisma.integrationConfig.deleteMany({ where: { id: configId } });
    if (templateRowId) await prisma.publishingTemplate.deleteMany({ where: { id: templateRowId } });
    if (variantId) {
      await prisma.dailyPrice.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, productVariantId: variantId } });
      await prisma.productVariant.deleteMany({ where: { id: variantId } });
      await prisma.productTemplate.deleteMany({ where: { id: templateId } });
      await prisma.productCategory.deleteMany({ where: { id: categoryId } });
      await prisma.uom.deleteMany({ where: { id: uomId } });
      await prisma.uomCategory.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: `P5W-${marker}` } });
    }
    await disconnectIntegrationPrisma();
  });
});
