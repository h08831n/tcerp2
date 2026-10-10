import {
  describeIntegration,
  integrationPrisma,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import {
  adminUserId,
  automationService,
  createSalesDocumentRow,
  createVariantInCompany,
  makeAdapters,
  publishingService,
} from '../testing/p5-fixtures';
import { cleanupSalesDocument, createParty } from '../testing/p4-fixtures';
import { parseDayKey, shiftDayKey, todayKey } from '../pricing/day';
import { SmsAudienceMember } from '../automation/automation.service';

/**
 * p5c-05 SEND_SMS audience extension points. actionConfig.audience =
 * {type: ALL_CUSTOMERS | INACTIVE_DAYS | PRODUCT_BUYERS, days?, productVariantId?}
 * resolves a CUSTOMER audience (resolveAudience); the daily scan runs an
 * audience rule ONCE per date and fans out one capped sms.send job per
 * member (`sms:daily:{ruleId}:{date}:audience:{partyId}`) — re-runs are
 * idempotent no-ops.
 */
describeIntegration('p5c-05 sms audience resolution + scan', () => {
  const prisma = integrationPrisma();
  // Hermetic company: the shared integration company carries months of
  // smoke/spec leftovers, which break audience counting assertions.
  let COMPANY = '';
  const marker = `p5c-05-${Date.now()}`;
  let actorId = '';
  let variantId = '';
  let templateId = '';
  let categoryId = '';
  let uomId = '';
  let inactiveBuyerId = ''; // old sale on the variant
  let recentCustomerId = ''; // fresh sale — NOT inactive
  let neverBuyerId = ''; // no sales at all
  let oldBuyerId = ''; // old sale on the variant
  const docIds: string[] = [];
  const mobileByParty = new Map<string, string>();
  const today = todayKey();

  beforeAll(async () => {
    const company = await prisma.company.create({
      data: { nameFa: `p5c-05 ${marker}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    // sequences not needed by this spec; GRN provisioning unnecessary.
  });

  let customerSeq = 0;
  const seedCustomer = async (label: string): Promise<{ id: string; mobile: string }> => {
    const party = await createParty(prisma, ['CUSTOMER'], `${marker}-${label}`, COMPANY);
    // Unique per company (partial unique index on normalizedValue).
    const mobile = `0912${String(Date.now()).slice(-5)}${String(++customerSeq).padStart(2, '0')}`;
    await prisma.partyPhone.create({
      data: {
        companyId: COMPANY,
        partyId: party.id,
        kind: 'MOBILE',
        rawValue: mobile,
        normalizedValue: mobile,
        isPrimary: true,
      },
    });
    mobileByParty.set(party.id, mobile);
    return { id: party.id, mobile };
  };

  const seedSale = async (
    customerPartyId: string,
    documentDate: Date,
    withVariantLine: boolean,
    label: string,
  ) => {
    const doc = await createSalesDocumentRow(prisma, COMPANY, {
      marker: `${marker}-${label}`,
      customerPartyId,
      salespersonUserId: actorId,
      status: 'COMPLETED',
      documentDate,
    });
    docIds.push(doc.id);
    if (withVariantLine) {
      await prisma.salesLine.create({
        data: {
          companyId: COMPANY,
          salesDocumentId: doc.id,
          productVariantId: variantId,
          orderedQuantity: 1,
          uomId,
          unitPrice: 1000,
          subtotal: 1000,
          lineTotal: 1000,
        },
      });
    }
  };

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const fixture = await createVariantInCompany(prisma, COMPANY, marker);
    variantId = fixture.variantId;
    templateId = fixture.templateId;
    categoryId = fixture.categoryId;
    uomId = fixture.uomId;

    const inactiveBuyer = await seedCustomer('ib');
    inactiveBuyerId = inactiveBuyer.id;
    const recent = await seedCustomer('rc');
    recentCustomerId = recent.id;
    const never = await seedCustomer('nv');
    neverBuyerId = never.id;
    const oldBuyer = await seedCustomer('ob');
    oldBuyerId = oldBuyer.id;

    await seedSale(inactiveBuyerId, parseDayKey(shiftDayKey(today, -30)), true, 'ib');
    await seedSale(recentCustomerId, parseDayKey(today), false, 'rc');
    await seedSale(oldBuyerId, parseDayKey(shiftDayKey(today, -40)), true, 'ob');
  });

  it('INACTIVE_DAYS resolves customers whose last sale is older than N days (incl. never-buyers)', async () => {
    const automation = automationService(prisma, publishingService(prisma, makeAdapters()));
    const members = await automation.resolveAudience(COMPANY, {
      type: 'INACTIVE_DAYS',
      days: 7,
    });
    const ids = members.map((m: SmsAudienceMember) => m.partyId);
    expect(ids).toContain(inactiveBuyerId);
    expect(ids).toContain(oldBuyerId);
    expect(ids).toContain(neverBuyerId); // no sale at all → inactive
    expect(ids).not.toContain(recentCustomerId);
    // Mobile enrichment is checked for MY parties only (the company is
    // shared and other specs' leftovers may appear in the audience).
    const mine = members.filter((m: SmsAudienceMember) =>
      [inactiveBuyerId, oldBuyerId, neverBuyerId].includes(m.partyId),
    );
    expect(mine).toHaveLength(3);
    for (const member of mine) {
      expect(member.mobile).toBe(mobileByParty.get(member.partyId));
    }
  });

  it('PRODUCT_BUYERS resolves distinct customers with a sales line on the variant', async () => {
    const automation = automationService(prisma, publishingService(prisma, makeAdapters()));
    const members = await automation.resolveAudience(COMPANY, {
      type: 'PRODUCT_BUYERS',
      productVariantId: variantId,
    });
    const ids = members.map((m: SmsAudienceMember) => m.partyId).sort();
    expect(ids).toEqual([inactiveBuyerId, oldBuyerId].sort());
  });

  it('ALL_CUSTOMERS resolves every non-archived CUSTOMER party', async () => {
    const automation = automationService(prisma, publishingService(prisma, makeAdapters()));
    const members = await automation.resolveAudience(COMPANY, { type: 'ALL_CUSTOMERS' });
    const ids = members.map((m: SmsAudienceMember) => m.partyId);
    for (const id of [inactiveBuyerId, recentCustomerId, neverBuyerId, oldBuyerId]) {
      expect(ids).toContain(id);
    }
  });

  it('the daily scan runs the audience rule ONCE per date and queues one sms per member', async () => {
    const automation = automationService(prisma, publishingService(prisma, makeAdapters()));
    const rule = await prisma.automationRule.create({
      data: {
        companyId: COMPANY,
        code: `P5C05-${marker}`,
        nameFa: `پیام مشتری راکد ${marker}`,
        triggerType: 'CUSTOMER_INACTIVE_DAYS',
        triggerConfig: { days: 7 },
        actionType: 'SEND_SMS',
        actionConfig: {
          text: 'سلام {partyName}، منتظرتان هستیم',
          audience: { type: 'INACTIVE_DAYS', days: 7 },
        },
        enabled: true,
        version: 1,
      },
    });

    const smsJobsFor = () =>
      prisma.queueJob.count({
        where: { companyId: COMPANY, jobType: 'sms.send', idempotencyKey: { startsWith: `sms:daily:${rule.id}:` } },
      });

    // The company is shared — resolve the audience first and assert
    // RELATIVE to it (other specs' leftovers must not break the counts).
    const members = await automation.resolveAudience(COMPANY, {
      type: 'INACTIVE_DAYS',
      days: 7,
    });
    const myTargets = [inactiveBuyerId, oldBuyerId, neverBuyerId].map(
      (id) => mobileByParty.get(id) as string,
    );

    const summaries = await automation.dailyScan({
      companyId: COMPANY,
      ruleId: rule.id,
      date: today,
    });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].candidates).toBe(members.length);
    expect(summaries[0].executed).toBe(1);

    const jobs = await prisma.queueJob.findMany({
      where: { companyId: COMPANY, jobType: 'sms.send', idempotencyKey: { startsWith: `sms:daily:${rule.id}:` } },
    });
    expect(jobs).toHaveLength(members.filter((m: SmsAudienceMember) => m.mobile).length);
    const targets = jobs.map((job) => (job.payload as { to: string }).to).sort();
    for (const mobile of myTargets) {
      expect(targets).toContain(mobile);
    }
    // One job per member party, keyed into the run's idempotency chain.
    const keyedParties = jobs.map((job) => (job.idempotencyKey ?? '').split(':').pop());
    for (const id of [inactiveBuyerId, oldBuyerId, neverBuyerId]) {
      expect(keyedParties).toContain(id);
    }
    for (const id of [inactiveBuyerId, oldBuyerId, neverBuyerId]) {
      const job = jobs.find((j) => (j.idempotencyKey ?? '').endsWith(`:${id}`));
      const payload = job?.payload as { to: string; text: string };
      expect(payload.text).toContain('سلام');
      const party = await prisma.party.findUniqueOrThrow({ where: { id }, select: { nameFa: true } });
      expect(payload.text).toContain(party.nameFa);
    }

    // Idempotency: a same-date re-run creates NO new jobs.
    const before = await smsJobsFor();
    const rerun = await automation.dailyScan({
      companyId: COMPANY,
      ruleId: rule.id,
      date: today,
    });
    expect(rerun[0].skippedDuplicates).toBe(1);
    expect(await smsJobsFor()).toBe(before);
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({ where: { companyId: COMPANY, jobType: 'sms.send' } });
    await prisma.automationRun.deleteMany({ where: { rule: { code: `P5C05-${marker}` } } });
    await prisma.automationRule.deleteMany({ where: { code: `P5C05-${marker}` } });
    for (const id of docIds) await cleanupSalesDocument(prisma, id);
    await prisma.party.deleteMany({
      where: { id: { in: [inactiveBuyerId, recentCustomerId, neverBuyerId, oldBuyerId] } },
    });
    await prisma.productVariant.deleteMany({ where: { id: variantId } });
    await prisma.productTemplate.deleteMany({ where: { id: templateId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    if (uomId) {
      await prisma.uom.deleteMany({ where: { id: uomId } });
      await prisma.uomCategory.deleteMany({ where: { companyId: COMPANY, code: `P5W-${marker}` } });
    }
    await disconnectIntegrationPrisma();
  });
});
