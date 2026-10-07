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
 * p5-13 automation-quotation-pending: an old QUOTATION (older than the
 * rule's N days) triggers a reminder run for its salesperson via the daily
 * scan; re-running the scan does not duplicate the reminder.
 */
describeIntegration('p5-13 automation-quotation-pending', () => {
  const prisma = integrationPrisma();
  const marker = `p5-13-${Date.now()}`;
  let actorId = '';
  let partyId = '';
  let ruleId = '';
  let documentId = '';
  let runId = '';
  let runsAfterFirstScan = 0;
  const adapters = makeAdapters();

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const party = await createParty(prisma, ['CUSTOMER'], marker);
    partyId = party.id;

    const document = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker,
      customerPartyId: partyId,
      salespersonUserId: actorId,
      status: 'QUOTATION',
      documentDate: new Date(shiftDayKey(todayKey(), -10)),
    });
    documentId = document.id;

    const rule = await prisma.automationRule.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `P5-13-${marker}`,
        nameFa: 'پیگیری پیش‌فاکتور معلق',
        triggerType: 'QUOTATION_PENDING_DAYS',
        triggerConfig: { days: 7 },
        actionType: 'CREATE_ACTIVITY',
        actionConfig: {
          title: 'پیگیری پیش‌فاکتور {documentNumber}',
          body: 'پیش‌فاکتور {ageDays} روز است معلق است',
          recipients: [{ type: 'RECORD_OWNER', value: '' }],
        },
        enabled: true,
      },
    });
    ruleId = rule.id;
  });

  it('the daily scan creates a reminder run for the old QUOTATION', async () => {
    const automation = automationService(prisma, publishingService(prisma, adapters));
    const summaries = await automation.dailyScan({ companyId: INTEGRATION_COMPANY_ID, date: todayKey() });
    const summary = summaries.find((s) => s.ruleId === ruleId);
    expect(summary).toBeDefined();
    expect(summary!.executed).toBeGreaterThanOrEqual(1);

    const run = await prisma.automationRun.findFirstOrThrow({
      where: { ruleId, triggerPayload: { path: ['documentId'], equals: documentId } },
    });
    runId = run.id;
    expect(run.status).toBe('SUCCESS');
    expect(run.idempotencyKey).toBe(`daily:${ruleId}:${todayKey()}:${documentId}`);
    expect((run.triggerPayload as { documentNumber: string }).documentNumber).toContain('P5SD-');

    // CREATE_ACTIVITY reminder (no Activity model in Phase 5 → tagged
    // notification) reaches the salesperson (record owner).
    const reminder = await prisma.notification.findFirstOrThrow({
      where: { userId: actorId, relatedEntityId: run.id, relatedEntityType: 'automation_activity' },
    });
    expect(reminder.title).toContain('پیگیری');

    runsAfterFirstScan = await prisma.automationRun.count({ where: { ruleId } });
  });

  it('re-running the scan does not duplicate the reminder', async () => {
    const automation = automationService(prisma, publishingService(prisma, adapters));
    await automation.dailyScan({ companyId: INTEGRATION_COMPANY_ID, date: todayKey() });

    const runCount = await prisma.automationRun.count({
      where: { ruleId, idempotencyKey: `daily:${ruleId}:${todayKey()}:${documentId}` },
    });
    expect(runCount).toBe(1);

    // No NEW runs for the rule, and THIS document's run has ONE reminder.
    expect(await prisma.automationRun.count({ where: { ruleId } })).toBe(runsAfterFirstScan);
    expect(
      await prisma.notification.count({
        where: { userId: actorId, relatedEntityType: 'automation_activity', relatedEntityId: runId },
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
