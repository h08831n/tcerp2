import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, makeQueueService } from '../testing/p5-fixtures';
import { defaultPublishingAdapters } from '../publishing/adapters/mock-publishing.adapter';
import { PrismaClient, Prisma, SmsMessageStatus, SmsMessageSource } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { QueueService } from '../queue/queue.service';
import { PublishChannel } from '@prisma/client';
import {
  NotificationService,
  NotificationRuleService,
} from '../notifications/notifications.service';
import { SmsSendHandler } from '../publishing/sms-send.handler';
import { SmsService, SmsTemplateService } from '../notifications/sms.service';
import type { PublishingAdapter } from '../publishing/publishing-adapter';

jest.setTimeout(180000);

/**
 * p9d — Phase 9D notification/SMS center:
 *   d-01 rule channels honored: IN_APP notification + SMS log row with
 *        rendered template text and a queued sms.send job;
 *   d-02 duplicate dispatch reconciles to ONE SmsMessage (eventKey dedup);
 *   d-03 handler flips QUEUED→SENT, failures land FAILED with error and a
 *        resend creates a fresh row;
 *   d-04 manual send: mobile canonicalization, opt-in dedup, fresh sends;
 *   d-05 templates CRUD + render (inactive template rejected);
 *   d-06 automation audience SMS now logs SmsMessage rows (source AUTOMATION).
 */
describeIntegration('p9d notification/SMS center', () => {
  const prisma = integrationPrisma();
  const marker = `p9d-${Date.now()}`;
  let actorId = '';
  let queue: QueueService;
  let sms: SmsService;
  let templates: SmsTemplateService;
  let notifications: NotificationService;
  let ruleService: NotificationRuleService;
  const ruleIds: string[] = [];
  const partyIds: string[] = [];
  const templateIds: string[] = [];

  const cleanup = async () => {
    await prisma.smsMessage.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: 'notification-sms:' } } });
    await prisma.smsMessage.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { contains: marker } } });
    await prisma.smsMessage.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: 'sms:p9d' } } });
    await prisma.smsMessage.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: `sms-resend:` } } });
    await prisma.activity.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: 'activity:daily:p9d' } } }).catch(() => undefined);
    await prisma.notificationRule.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9D-' } } });
    await prisma.smsTemplate.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: 'P9D-' } } });
    await prisma.notification.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, relatedEntityType: 'automation_run' } });
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: { in: ['sms.send', 'automation.run'] } } });
    await prisma.party.deleteMany({ where: { id: { in: partyIds } } });
  };

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    queue = makeQueueService(prisma);
    const audit = new AuditService(prisma as never);
    sms = new SmsService(prisma as never, queue, audit);
    templates = new SmsTemplateService(prisma as never, audit);
    notifications = new NotificationService(prisma as never, queue, sms);
    ruleService = new NotificationRuleService(prisma as never, audit);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectIntegrationPrisma();
  });

  const ctx = {} as never;
  const actor = () => ({ id: actorId, username: 'admin' });

  async function makeParty(mobile: string): Promise<string> {
    const party = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        type: 'COMPANY',
        nameFa: `p9d مشتری ${Date.now()}-${partyIds.length}`,
        phones: { create: { companyId: INTEGRATION_COMPANY_ID, kind: 'MOBILE', rawValue: mobile, normalizedValue: mobile } },
      },
      select: { id: true },
    });
    partyIds.push(party.id);
    return party.id;
  }

  it('d-01 channels [IN_APP, SMS] dispatch both: in-app row + logged SMS with rendered template', async () => {
    const template = await templates.create(
      INTEGRATION_COMPANY_ID,
      { code: `P9D-TPL-${Date.now()}`, nameFa: 'خوش‌آمد', bodyTemplate: '{partyName} عزیز، ثبت شد ({eventKey}).' },
      actor(), ctx,
    );
    templateIds.push(template.id);
    const partyId = await makeParty('09121110000');

    const rule = await ruleService.create(
      INTEGRATION_COMPANY_ID,
      {
        code: `P9D-CH-${Date.now()}`,
        event: 'p9d.event',
        recipientConfig: [{ type: 'RECORD_OWNER', value: '' }],
        channels: ['IN_APP', 'SMS'],
        smsConfig: { templateCode: template.code, usePayloadParty: true },
        enabled: true,
      } as never,
      actor(), ctx,
    );
    ruleIds.push(rule.id);

    const payload = { partyId, partyName: 'شرکت فولاد', recordOwnerId: actorId, eventKey: '2026-10-31-1' };
    const dispatched = await notifications.dispatchRulesForEvent('p9d.event', payload, {
      companyId: INTEGRATION_COMPANY_ID,
      title: 'رویداد تست',
    });
    expect(dispatched).toBe(1);

    // IN_APP: owner notification exists
    expect(
      await prisma.notification.count({ where: { userId: actorId, title: 'رویداد تست' } }),
    ).toBeGreaterThanOrEqual(1);

    // SMS: ONE QUEUED log row, template rendered with payload vars
    const messages = await prisma.smsMessage.findMany({
      where: { companyId: INTEGRATION_COMPANY_ID, source: 'NOTIFICATION_RULE', partyId },
    });
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message.status).toBe('QUEUED');
    expect(message.templateCode).toBe(template.code);
    expect(message.text).toContain('شرکت فولاد');
    expect(message.to).toBe('09121110000');
    expect(message.idempotencyKey).toBe(`notification-sms:${rule.id}:${partyId}:2026-10-31-1`);
    const job = await prisma.queueJob.findFirst({ where: { idempotencyKey: `sms-job:${message.id}` } });
    expect(job).not.toBeNull();
  });

  it('d-02 duplicate dispatch (same eventKey) reconciles to the SAME message', async () => {
    const partyId = await makeParty('09122220000');
    const rule = await ruleService.create(
      INTEGRATION_COMPANY_ID,
      {
        code: `P9D-DUP-${Date.now()}`,
        event: 'p9d.dup',
        recipientConfig: [],
        channels: ['SMS'],
        smsConfig: { text: 'یادآوری برای {partyName}' },
        enabled: true,
      } as never,
      actor(), ctx,
    );
    ruleIds.push(rule.id);
    const payload = { partyId, partyName: 'تکراری', eventKey: 'once-1' };
    const first = await notifications.dispatchRulesForEvent('p9d.dup', payload, {
      companyId: INTEGRATION_COMPANY_ID, title: 'x',
    });
    expect(first).toBe(1);
    const second = await notifications.dispatchRulesForEvent('p9d.dup', payload, {
      companyId: INTEGRATION_COMPANY_ID, title: 'x',
    });
    expect(second).toBe(1); // rule still matched — but no NEW message
    const messages = await prisma.smsMessage.count({
      where: { companyId: INTEGRATION_COMPANY_ID, partyId, source: 'NOTIFICATION_RULE' },
    });
    expect(messages).toBe(1);
  });

  it('d-03 handler flips QUEUED→SENT; adapter failure lands FAILED and resend opens a fresh row', async () => {
    // success path through the REAL handler with the mock SMS adapter
    const okMessage = await prisma.smsMessage.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        to: '09123330000',
        text: 'ارسال موفق p9d',
        source: 'MANUAL',
        idempotencyKey: `p9d-ok-${Date.now()}`,
      },
    });
    // SMS IntegrationConfig + handler with the default (mock) adapters
    const config = await prisma.integrationConfig.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `p9d-sms-cfg-${Date.now()}`,
        name: 'SMS mock',
        type: 'SMS',
        isActive: true,
        config: { mode: 'mock' },
      },
    });
    const handler = new SmsSendHandler(prisma as never, defaultPublishingAdapters());
    await handler.handle({ smsMessageId: okMessage.id });
    const sent = await prisma.smsMessage.findUniqueOrThrow({ where: { id: okMessage.id } });
    expect(sent.status).toBe('SENT');
    expect(sent.sentAt).not.toBeNull();

    // failure path: deterministic FAILING SMS adapter (the shared company may
    // hold other active SMS configs — never rely on their absence) → row FAILED
    const failingAdapter = {
      channel: 'SMS',
      send: async () => ({ ok: false, providerResponse: { error: 'INJECTED_SMS_DOWN' } }),
    } as never;
    const failingHandler = new SmsSendHandler(prisma as never, [failingAdapter]);
    const failMessage = await prisma.smsMessage.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        to: '09123330001',
        text: 'ارسال شکست‌خورده p9d',
        source: 'MANUAL',
        idempotencyKey: `p9d-fail-${Date.now()}`,
      },
    });
    await expect(failingHandler.handle({ smsMessageId: failMessage.id })).rejects.toThrow(
      'INJECTED_SMS_DOWN',
    );
    const failed = await prisma.smsMessage.findUniqueOrThrow({ where: { id: failMessage.id } });
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toContain('INJECTED_SMS_DOWN');

    // resend: fresh row, original untouched
    const resent = await sms.resend(INTEGRATION_COMPANY_ID, failed.id, actor(), ctx);
    expect(resent.id).not.toBe(failed.id);
    expect(resent.status).toBe('QUEUED');
    expect(resent.source).toBe('MANUAL');
    const original = await prisma.smsMessage.findUniqueOrThrow({ where: { id: failed.id } });
    expect(original.status).toBe('FAILED');
    // resend of a SENT message is rejected
    await expect(
      sms.resend(INTEGRATION_COMPANY_ID, okMessage.id, actor(), ctx),
    ).rejects.toMatchObject({ message: 'SMS_RESEND_ONLY_FAILED' });
  });

  it('d-04 manual send: canonicalizes mobiles, opt-in dedup, fresh sends are new rows', async () => {
    // canonicalization + explicit dedup key reconciles
    const first = await sms.enqueueSend(INTEGRATION_COMPANY_ID, {
      to: '+98 912 444 0000',
      text: 'سلام {name}',
      source: 'MANUAL',
      requestedById: actorId,
      idempotencyKey: `p9d-dedup-${marker}`,
    });
    expect(first.created).toBe(true);
    expect(first.message.to).toBe('09124440000');
    const again = await sms.enqueueSend(INTEGRATION_COMPANY_ID, {
      to: '09124440000',
      text: 'سلام {name}',
      source: 'MANUAL',
      requestedById: actorId,
      idempotencyKey: `p9d-dedup-${marker}`,
    });
    expect(again.created).toBe(false);
    expect(again.message.id).toBe(first.message.id);
    // fresh send (no key) is a NEW row
    const fresh = await sms.enqueueSend(INTEGRATION_COMPANY_ID, {
      to: '09124440000',
      text: 'ارسال جدید',
      source: 'MANUAL',
      requestedById: actorId,
      idempotencyKey: `p9d-fresh-${Date.now()}-1`,
    });
    expect(fresh.created).toBe(true);
    expect(fresh.message.id).not.toBe(first.message.id);
    // invalid mobile rejected
    await expect(
      sms.enqueueSend(INTEGRATION_COMPANY_ID, {
        to: '12345',
        text: 'x',
        source: 'MANUAL',
        idempotencyKey: `p9d-bad-${Date.now()}`,
      }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
  });

  it('d-05 templates: create, list, deactivate → render rejects inactive', async () => {
    const template = await templates.create(
      INTEGRATION_COMPANY_ID,
      { code: `P9D-T2-${Date.now()}`, nameFa: 'اعلام قیمت', bodyTemplate: '{product} به {price} رسید' },
      actor(), ctx,
    );
    templateIds.push(template.id);
    const rendered = await sms.render(
      INTEGRATION_COMPANY_ID,
      { templateCode: template.code },
      { product: 'میلگرد ۱۶', price: '۳۵۰۰۰' },
    );
    expect(rendered.text).toBe('میلگرد ۱۶ به ۳۵۰۰۰ رسید');
    expect(rendered.templateCode).toBe(template.code);
    await templates.update(INTEGRATION_COMPANY_ID, template.id, { isActive: false }, actor(), ctx);
    await expect(
      sms.render(INTEGRATION_COMPANY_ID, { templateCode: template.code }, {}),
    ).rejects.toMatchObject({ name: 'NotFoundError' });
    // literal text fallback still works
    const literal = await sms.render(INTEGRATION_COMPANY_ID, { text: 'کد {code}' }, { code: 'X1' });
    expect(literal.text).toBe('کد X1');
    await expect(sms.render(INTEGRATION_COMPANY_ID, {}, {})).rejects.toMatchObject({
      message: 'SMS_TEXT_REQUIRED',
    });
  });

  it('d-06 automation SEND_SMS logs SmsMessage rows (source AUTOMATION)', async () => {
    const rule = await prisma.automationRule.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P9D-AUTO-${Date.now()}`,
        nameFa: 'پیامک دستی اتوماسیون p9d',
        triggerType: 'MANUAL',
        triggerConfig: {} as Prisma.InputJsonValue,
        actionType: 'SEND_SMS',
        actionConfig: { text: 'مشتری عزیز {partyName}' } as Prisma.InputJsonValue,
        enabled: true,
      },
    });
    const { AutomationService } = await import('./automation.service');
    const { PublishingService } = await import('../publishing/publishing.service');
    const { ActivityService } = await import('../activities/activity.service');
    const { TimelineService } = await import('../parties/timeline.service');
    const audit = new AuditService(prisma as never);
    const timeline = new TimelineService(prisma as never);
    const activityService = new ActivityService(prisma as never, timeline, audit);
    const { NotificationService: NS } = await import('../notifications/notifications.service');
    const ns = new NS(prisma as never, queue, sms);
    const publishingStub = { createAutoBatch: async () => { throw new Error('unused'); } } as never;
    void PublishingService;
    void PublishChannel;
    void SmsMessageStatus;
    void SmsMessageSource;
    void ruleIds;
    const automation = new AutomationService(
      prisma as never, audit, queue, publishingStub, ns, activityService, sms,
    );
    const result = await automation.manualRun(INTEGRATION_COMPANY_ID, rule.id, {} as never);
    // the MANUAL event carries no mobile → NO_MOBILE (no row) is correct;
    // feed one through a direct run row to prove the logged path.
    const run = await prisma.automationRun.create({
      data: {
        ruleId: rule.id,
        ruleVersion: rule.version,
        triggerPayload: { partyName: 'مشتری p9d', mobile: '09126660000', partyId: partyIds[0] } as Prisma.InputJsonValue,
        status: 'PENDING',
        idempotencyKey: `p9d-auto-${rule.id}`,
      },
    });
    const done = await automation.executeRun(run.id);
    expect(done?.status).toBe('SUCCESS');
    void result;
    const logged = await prisma.smsMessage.findUniqueOrThrow({
      where: { idempotencyKey: `sms:p9d-auto-${rule.id}` },
    });
    expect(logged.source).toBe('AUTOMATION');
    expect(logged.status).toBe('QUEUED');
    expect(logged.to).toBe('09126660000');
    expect(logged.partyId).toBe(partyIds[0]);
    expect(logged.sourceId).toBe(run.id);
    await prisma.automationRule.delete({ where: { id: rule.id } });
  });
});
