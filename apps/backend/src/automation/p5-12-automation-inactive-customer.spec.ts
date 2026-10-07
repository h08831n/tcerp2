import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  createParty,
  createSalesDocumentRow,
  automationService,
  publishingService,
  makeAdapters,
} from '../testing/p5-fixtures';
import { shiftDayKey, todayKey } from '../pricing/day';

/**
 * p5-12 automation-inactive-customer: a seeded customer whose last sale is
 * older than the rule's N days is matched by the daily scan → a run row is
 * created (idempotencyKey `daily:{ruleId}:{date}:{partyId}`) and a
 * CREATE_NOTIFICATION reminder lands for the record owner; re-running the
 * scan is fully idempotent (no duplicate run/notification).
 */
describeIntegration('p5-12 automation-inactive-customer', () => {
  const prisma = integrationPrisma();
  const marker = `p5-12-${Date.now()}`;
  let actorId = '';
  let partyId = '';
  let ruleId = '';
  let documentId = '';
  const adapters = makeAdapters();

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const party = await createParty(prisma, ['CUSTOMER'], marker);
    partyId = party.id;
    await prisma.party.update({ where: { id: partyId }, data: { ownerUserId: actorId } });

    // One old sale (90 days ago) → inactive for a 30-day rule.
    const document = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker,
      customerPartyId: partyId,
      salespersonUserId: actorId,
      status: 'COMPLETED',
      documentDate: new Date(shiftDayKey(todayKey(), -90)),
    });
    documentId = document.id;

    const rule = await prisma.automationRule.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P5-12-${marker}`,
        nameFa: 'یادآوری مشتری راکد',
        triggerType: 'CUSTOMER_INACTIVE_DAYS',
        triggerConfig: { days: 30 },
        actionType: 'CREATE_NOTIFICATION',
        actionConfig: {
          title: 'مشتری راکد: {partyName}',
          body: '{partyName} روزها بدون خرید',
          recipients: [{ type: 'RECORD_OWNER', value: '' }],
        },
        enabled: true,
      },
    });
    ruleId = rule.id;
  });

  let runId = '';
  let runsAfterFirstScan = 0;

  it('the daily scan creates ONE run + ONE notification for the inactive customer', async () => {
    const automation = automationService(prisma, publishingService(prisma, adapters));
    const summaries = await automation.dailyScan({ companyId: INTEGRATION_COMPANY_ID, date: todayKey() });
    const summary = summaries.find((s) => s.ruleId === ruleId);
    expect(summary).toBeDefined();
    expect(summary!.candidates).toBeGreaterThanOrEqual(1);
    expect(summary!.executed).toBeGreaterThanOrEqual(1);

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { ruleId, triggerPayload: { path: ['partyId'], equals: partyId } },
    });
    runId = run.id;
    expect(run.status).toBe('SUCCESS');
    expect(run.idempotencyKey).toBe(`daily:${ruleId}:${todayKey()}:${partyId}`);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: actorId, relatedEntityId: run.id },
    });
    expect(notification.companyId).toBe(INTEGRATION_COMPANY_ID);
    expect(notification.title).toContain('طرف قرارداد'); // {partyName} interpolated

    runsAfterFirstScan = await prisma.automationRun.count({ where: { ruleId } });
  });

  it('re-running the scan is idempotent (key prevents duplicate runs/SMS/notifications)', async () => {
    const automation = automationService(prisma, publishingService(prisma, adapters));
    const summaries = await automation.dailyScan({ companyId: INTEGRATION_COMPANY_ID, date: todayKey() });
    const summary = summaries.find((s) => s.ruleId === ruleId);
    expect(summary!.executed).toBe(0); // nothing new executed

    const runCount = await prisma.automationRun.count({
      where: { ruleId, idempotencyKey: `daily:${ruleId}:${todayKey()}:${partyId}` },
    });
    expect(runCount).toBe(1);

    // No NEW runs appeared for the rule…
    expect(await prisma.automationRun.count({ where: { ruleId } })).toBe(runsAfterFirstScan);

    // …and the run for THIS party produced exactly ONE notification.
    expect(
      await prisma.notification.count({
        where: { userId: actorId, relatedEntityType: 'automation_run', relatedEntityId: runId },
      }),
    ).toBe(1);
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, relatedEntityType: { in: ['automation_run', 'automation_activity'] } } });
    await prisma.queueJob.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, jobType: { in: ['automation.run', 'sms.send'] } } });
    await prisma.automationRun.deleteMany({ where: { ruleId } });
    await prisma.automationRule.deleteMany({ where: { id: ruleId } });
    await prisma.salesDocument.deleteMany({ where: { id: documentId } });
    await prisma.party.deleteMany({ where: { id: partyId } });
    await disconnectIntegrationPrisma();
  });
});
