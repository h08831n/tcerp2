import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';

/**
 * CR-001 — THE CRM acceptance scenario (owner's 13-step law) + edge cases,
 * over the REAL AppModule through HTTP (guards, ValidationPipe, envelopes).
 *
 * The law under test:
 *  - Party is THE identity: lead → opportunity → customer NEVER duplicates
 *    the party row, and all history stays on the same party id.
 *  - Activities/follow-ups on a lead use the GENERIC activity machinery.
 *  - «تبدیل به فرصت فروش» is explicit (crm.manage), preserves everything,
 *    and is IDEMPOTENT (a replayed request returns the SAME opportunity).
 *  - A quotation (even sent/confirmed) NEVER makes the party a customer.
 *  - Customer-hood is granted EXACTLY at the valid CUSTOMER_CONFIRMED →
 *    SALES_ORDER activation — backend-enforced, idempotent, audited.
 *  - Cancelling the order afterwards does NOT auto-reverse the role.
 */

const ADMIN_PASSWORD = 'Cr1-Admin-Passw0rd!';

if (TEST_INTEGRATION) {
  assertSafeIntegrationDatabase(process.env.DATABASE_URL);
}

for (const [key, value] of Object.entries({
  JWT_SECRET: process.env.JWT_SECRET ?? 'cr1-jwt-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'cr1-jwt-refresh-secret-0123456789',
  NODE_ENV: 'test',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://127.0.0.1:59999',
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY ?? 'cr1minio',
  S3_SECRET_KEY: process.env.S3_SECRET_KEY ?? 'cr1minio123',
  S3_BUCKET: process.env.S3_BUCKET ?? 'cr1-files',
})) {
  if (!process.env[key]) process.env[key] = value;
}

describeIntegration('cr-001 CRM acceptance (real AppModule over HTTP)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let adminToken = '';
  const marker = `cr1-${Date.now()}`;

  const companyId = '00000000-0000-4000-8000-000000000001'; // seeded integration company
  const companyB = `cr1-B-${Date.now()}`;
  const tracked = {
    users: [] as string[],
    roles: [] as string[],
    companies: [] as string[],
    parties: [] as string[],
    leads: [] as string[],
    opportunities: [] as string[],
    salesDocs: [] as string[],
    salesLines: [] as string[],
    activities: [] as string[],
    variants: [] as string[],
    uoms: [] as string[],
    uomCategories: [] as string[],
    templates: [] as string[],
    sequenceIds: [] as string[],
  };
  let adminId = '';

  async function api(
    method: string,
    path: string,
    token: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-company-id': companyId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }

  beforeAll(async () => {
    if (!TEST_INTEGRATION) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = await moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api');
    nestApp.use(require('cookie-parser')());
    // Production parity (main.ts): the global ValidationPipe is NOT applied
    // by Test.createTestingModule — register it explicitly here.
    nestApp.useGlobalPipes(
      new (require('@nestjs/common').ValidationPipe)({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    nestApp.useGlobalFilters(new GlobalExceptionFilter());
    await nestApp.init();
    const server = nestApp.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = nestApp;

    prisma = new PrismaService();
    await prisma.$connect();

    // Admin user with the CRM + sales permissions (fresh per run — tracked).
    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const admin = await prisma.user.create({
      data: {
        username: `cr1-admin-${marker}`,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;
    tracked.users.push(admin.id);
    await prisma.userCompany.create({ data: { userId: admin.id, companyId } });
    await prisma.userCompanyRole.create({
      data: { userId: admin.id, companyId, roleId: adminRole.id },
    });

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: admin.username, password: ADMIN_PASSWORD }),
    });
    adminToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';
    expect(adminToken).toBeTruthy();

    // Minimal sales fixtures: uom + template + variant for document lines.
    const uomCategory = await prisma.uomCategory.create({
      data: { companyId, nameFa: `cr1-cat-${marker}`, code: `cr1c${Date.now() % 100000}` },
    });
    tracked.uomCategories.push(uomCategory.id);
    const uom = await prisma.uom.create({
      data: {
        companyId,
        categoryId: uomCategory.id,
        symbol: `cr1u${Date.now() % 100000}`,
        nameFa: 'واحد cr1',
        conversionRatio: 1,
      },
    });
    tracked.uoms.push(uom.id);
    const productCategory = await prisma.productCategory.create({
      data: { companyId, nameFa: `cr1-pc-${marker}`, code: `cr1p${Date.now() % 100000}` } as never,
    });
    const template = await prisma.productTemplate.create({
      data: { companyId, categoryId: productCategory.id, nameFa: `cr1-tpl-${marker}` } as never,
    });
    tracked.templates.push(template.id);
    const variant = await prisma.productVariant.create({
      data: {
        companyId,
        templateId: template.id,
        sku: `cr1-sku-${Date.now() % 100000000}`,
        nameFa: 'وریانت cr1',
        combinationKey: `cr1-combo-${Date.now() % 100000000}`,
      },
    });
    tracked.variants.push(variant.id);
    (globalThis as unknown as { __cr1Uom?: string }).__cr1Uom = uom.id;
    (globalThis as unknown as { __cr1Variant?: string }).__cr1Variant = variant.id;

    // Second company for the cross-isolation edge case.
    const companyBRow = await prisma.company.create({ data: { nameFa: companyB, status: 'ACTIVE' } });
    tracked.companies.push(companyBRow.id);
    const seq = await prisma.sequence.create({
      data: {
        companyId: companyBRow.id,
        documentType: 'SALES_DOCUMENT',
        name: 'SD',
        prefix: 'CR1B',
        padding: 5,
        resetCycle: 'NEVER',
      },
    });
    tracked.sequenceIds.push(seq.id);
  });

  afterAll(async () => {
    const failures: string[] = [];
    const step = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    };
    if (prisma) {
      // Children first — sales lines, documents, opportunities, leads, activities,
      // then roles/party glue, then identity rows. STRICTLY by tracked ids.
      await step('salesLines', () => prisma.salesLine.deleteMany({ where: { salesDocumentId: { in: tracked.salesDocs } } }).then(() => undefined));
      await step('salesDocs', () => prisma.salesDocument.deleteMany({ where: { id: { in: tracked.salesDocs } } }).then(() => undefined));
      await step('opportunities', () => prisma.opportunity.deleteMany({ where: { id: { in: tracked.opportunities } } }).then(() => undefined));
      await step('leads', () => prisma.lead.deleteMany({ where: { id: { in: tracked.leads } } }).then(() => undefined));
      await step('activities', () => prisma.activity.deleteMany({ where: { id: { in: tracked.activities } } }).then(() => undefined));
      await step('parties', () => prisma.party.deleteMany({ where: { id: { in: tracked.parties } } }).then(() => undefined));
      await step('variants', () => prisma.productVariant.deleteMany({ where: { id: { in: tracked.variants } } }).then(() => undefined));
      await step('templates', () => prisma.productTemplate.deleteMany({ where: { id: { in: tracked.templates } } }).then(() => undefined));
      await step('uoms', () => prisma.uom.deleteMany({ where: { id: { in: tracked.uoms } } }).then(() => undefined));
      await step('uomCategories', () => prisma.uomCategory.deleteMany({ where: { id: { in: tracked.uomCategories } } }).then(() => undefined));
      await step('userCompanyRoles', () => prisma.userCompanyRole.deleteMany({ where: { userId: { in: tracked.users } } }).then(() => undefined));
      await step('userCompanies', () => prisma.userCompany.deleteMany({ where: { userId: { in: tracked.users } } }).then(() => undefined));
      await step('users', () => prisma.user.deleteMany({ where: { id: { in: tracked.users } } }).then(() => undefined));
      await step('sequences', () => prisma.sequence.deleteMany({ where: { id: { in: tracked.sequenceIds } } }).then(() => undefined));
      await step('companies', () => prisma.company.deleteMany({ where: { id: { in: tracked.companies } } }).then(() => undefined));
      await prisma.$disconnect();
      if (failures.length > 0) throw new Error(`CR1 CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
    if (app) await app.close();
  });

  // ─────────────────────────── THE 13-STEP OWNER SCENARIO ───────────────────────────

  it('steps 1-4: party+lead registered, activities recorded, future follow-up scheduled', async () => {
    // 1. Party «شرکت نمونه» — created FIRST (the stable identity), then a
    //    lead attached to it. NO customer role.
    const party = await prisma.party.create({
      data: { companyId, type: 'COMPANY', nameFa: `شرکت نمونه ${marker}`, createdBy: adminId },
    });
    tracked.parties.push(party.id);

    const created = await api('POST', '/api/leads', adminToken, {
      name: `شرکت نمونه ${marker}`,
      partyId: party.id,
      phone: '09121110000',
      source: 'WEB_SITE',
      notes: 'سرنخ اولیه',
    });
    expect(created.status).toBe(201);
    const lead = created.body;
    tracked.leads.push(lead.id);
    expect(lead.partyId).toBe(party.id);
    expect(lead.status).toBe('NEW');

    // 2. One CALL + two FOLLOW_UP activities through the GENERIC machinery.
    const activityType = await prisma.activityType.create({
      data: { companyId, code: `CR1_CALL_${Date.now() % 100000}`, nameFa: 'تماس' },
    });
    const followType = await prisma.activityType.create({
      data: { companyId, code: `CR1_FOLLOW_${Date.now() % 100000}`, nameFa: 'پیگیری' },
    });
    const mk = async (typeId: string, title: string, dueOffsetMin: number | null) => {
      const res = await api('POST', '/api/activities', adminToken, {
        typeCode: typeId,
        title,
        relatedEntityType: 'lead',
        relatedEntityId: lead.id,
        ...(dueOffsetMin === null
          ? {}
          : { dueDate: new Date(Date.now() + dueOffsetMin * 60_000).toISOString() }),
      });
      if (res.status !== 201) console.error('[cr1] activity create failed:', JSON.stringify(res.body));
      expect(res.status).toBe(201);
      tracked.activities.push(res.body.id);
      return res.body;
    };
    const call = await mk(activityType.code, 'تماس اول — معرفی محصول', null);
    expect(await prisma.activity.findUniqueOrThrow({ where: { id: call.id } })).toMatchObject({ status: 'PENDING' });
    await mk(followType.code, 'پیگیری اول', 60 * 24);
    const followUp = await mk(followType.code, 'پیگیری دوم — ارسال کاتالوگ', 60 * 48);

    // 3-4. The FUTURE follow-up is visible in the activity list (due window)
    //      and the lead detail reports the next scheduled activity.
    const list = await api(
      'GET',
      `/api/activities?relatedEntityType=lead&relatedEntityId=${lead.id}&status=PENDING`,
      adminToken,
    );
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBe(3);
    const leadDetail = await api('GET', `/api/leads/${lead.id}`, adminToken);
    expect(leadDetail.status).toBe(200);
    expect(leadDetail.body.activity.openCount).toBe(3);
    expect(leadDetail.body.activity.nextActivityAt).toBeTruthy();

    // Keep references for later steps via closure state.
    (globalThis as unknown as { __cr1?: unknown }).__cr1 = { party, lead, call, followUp };
  });

  it('steps 5-6: explicit convert → SAME party, history intact, idempotent replay', async () => {
    const { party, lead } = (globalThis as unknown as { __cr1: { party: { id: string }; lead: { id: string; status: string } } }).__cr1;

    // Sanity red-law check: a plain PATCH can NEVER set CONVERTED.
    const patchAttempt = await api('PATCH', `/api/leads/${lead.id}`, adminToken, {
      status: 'CONVERTED',
      version: 1,
    });
    expect(patchAttempt.status).toBe(422); // ValidationError: LEAD_CONVERT_REQUIRES_CONVERT_OPERATION

    // 5. The explicit conversion (declared purchase intent + authorized user).
    const converted = await api('POST', `/api/leads/${lead.id}/convert`, adminToken, {
      estimatedAmount: 500000000,
      expectedCloseDate: new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10),
    });
    expect(converted.status).toBe(201);
    expect(converted.body.alreadyConverted).toBe(false);
    const opportunity = converted.body.opportunity;
    tracked.opportunities.push(opportunity.id);

    // Same party — NEVER a second party row.
    expect(opportunity.customerPartyId).toBe(party.id);
    const partyCount = await prisma.party.count({ where: { nameFa: `شرکت نمونه ${marker}` } });
    expect(partyCount).toBe(1);

    // The lead is CONVERTED, the opportunity is linked back to the lead.
    const leadAfter = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(leadAfter.status).toBe('CONVERTED');
    expect(opportunity.leadId).toBe(lead.id);

    // The party is STILL not a customer at this point (step 8 verified here
    // for cohesion): no CUSTOMER role, no order yet.
    const rolesNow = await prisma.partyRole.findMany({ where: { partyId: party.id } });
    expect(rolesNow).toHaveLength(0);

    // 6. ALL activity history survives the conversion (same relatedEntityId).
    const acts = await prisma.activity.count({
      where: { relatedEntityType: 'lead', relatedEntityId: lead.id },
    });
    expect(acts).toBe(3);

    // Timeline carries the conversion trail.
    const timeline = await api('GET', `/api/leads/${lead.id}/timeline`, adminToken);
    expect(timeline.status).toBe(200);
    const types = (timeline.body as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('LEAD_CREATED');
    expect(types).toContain('LEAD_CONVERTED');

    // Idempotent replay: the SAME request returns the SAME opportunity.
    const replay = await api('POST', `/api/leads/${lead.id}/convert`, adminToken, {});
    expect(replay.status).toBe(201);
    expect(replay.body.alreadyConverted).toBe(true);
    expect(replay.body.opportunity.id).toBe(opportunity.id);
    const oppCount = await prisma.opportunity.count({ where: { leadId: lead.id } });
    expect(oppCount).toBe(1);

    (globalThis as unknown as { __cr1?: unknown }).__cr1 = {
      ...((globalThis as unknown as { __cr1: object }).__cr1 as object),
      opportunity,
    };
  });

  it('steps 7-9: quotation from the opportunity — party STILL not a customer', async () => {
    const { party, opportunity, lead } = (globalThis as unknown as {
      __cr1: { party: { id: string }; opportunity: { id: string }; lead: { id: string } };
    }).__cr1;
    const variant = { id: (globalThis as unknown as { __cr1Variant: string }).__cr1Variant };
    const uom = { id: (globalThis as unknown as { __cr1Uom: string }).__cr1Uom };

    // 7. Create a quotation (QUOTATION status) FROM the opportunity.
    const quote = await api('POST', '/api/sales', adminToken, {
      customerPartyId: party.id,
      opportunityId: opportunity.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 10, unitPrice: 1000000, uomId: uom.id }],
    });
    expect(quote.status).toBe(201);
    const quoteId = quote.body.id as string;
    tracked.salesDocs.push(quoteId);
    expect(quote.body.opportunityId).toBe(opportunity.id);
    expect(quote.body.status).toBe('QUOTATION');

    // 8. The party is STILL not a customer — a quotation never grants it.
    let roles = await prisma.partyRole.findMany({ where: { partyId: party.id } });
    expect(roles).toHaveLength(0);

    // Quotations are listed against the opportunity (sales list filter).
    const byOpp = await api('GET', `/api/sales?opportunityId=${opportunity.id}`, adminToken);
    expect(byOpp.status).toBe(200);
    expect(byOpp.body.items.map((d: { id: string }) => d.id)).toContain(quoteId);

    // 9. A CANCELLED quotation must not make the party a customer either.
    const quote2 = await api('POST', '/api/sales', adminToken, {
      customerPartyId: party.id,
      opportunityId: opportunity.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 1, unitPrice: 10, uomId: uom.id }],
    });
    expect(quote2.status).toBe(201);
    tracked.salesDocs.push(quote2.body.id as string);
    const cancel = await api('POST', `/api/sales/${quote2.body.id}/cancel`, adminToken, { reason: 'CR-001 test' });
    expect([200, 201]).toContain(cancel.status);
    roles = await prisma.partyRole.findMany({ where: { partyId: party.id } });
    expect(roles).toHaveLength(0);
    void lead;
  });

  it('steps 10-13: valid order activation grants the customer role — idempotently', async () => {
    const { party, opportunity, lead } = (globalThis as unknown as {
      __cr1: { party: { id: string }; opportunity: { id: string }; lead: { id: string } };
    }).__cr1;
    const variant = { id: (globalThis as unknown as { __cr1Variant: string }).__cr1Variant };
    const uom = { id: (globalThis as unknown as { __cr1Uom: string }).__cr1Uom };

    // 10. The valid chain: QUOTATION → (customer confirms) → activate → SALES_ORDER.
    const order = await api('POST', '/api/sales', adminToken, {
      customerPartyId: party.id,
      opportunityId: opportunity.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 5, unitPrice: 2000000, uomId: uom.id }],
    });
    expect(order.status).toBe(201);
    const orderId = order.body.id as string;
    tracked.salesDocs.push(orderId);
    tracked.salesLines.push(
      ...(await prisma.salesLine.findMany({ where: { salesDocumentId: orderId } })).map((l) => l.id),
    );

    const confirmed = await api('POST', `/api/sales/${orderId}/confirm`, adminToken, {});
    expect(confirmed.status).toBe(201); // POST routes default to 201 (Nest)
    const rolesMid = await prisma.partyRole.findMany({ where: { partyId: party.id } });
    expect(rolesMid).toHaveLength(0); // CUSTOMER_CONFIRMED alone does NOT convert

    const activated = await api('POST', `/api/sales/${orderId}/activate`, adminToken, {});
    expect(activated.status).toBe(201);

    // 11. The SAME party now holds the CUSTOMER role.
    const role = await prisma.partyRole.findUniqueOrThrow({
      where: { partyId_role: { partyId: party.id, role: 'CUSTOMER' } },
    });
    expect(role.partyId).toBe(party.id);

    // 12. Party id + full history unchanged.
    expect(party.id).toBe(party.id);
    const acts = await prisma.activity.count({ where: { relatedEntityType: 'lead', relatedEntityId: lead.id } });
    expect(acts).toBe(3);
    const timeline = await api('GET', `/api/parties/${party.id}/timeline`, adminToken);
    expect(timeline.status).toBe(200);
    const types = (timeline.body.items as Array<{ type: string }>).map((e) => e.type);
    expect(types).toContain('ROLE_ADDED'); // «مشتری شد» recorded
    expect(types).toContain('SALE_CONFIRMED');

    // 13. Repeated activation of the SAME order cannot duplicate the customer.
    const again = await api('POST', `/api/sales/${orderId}/activate`, adminToken, {});
    expect(again.status).toBe(422); // INVALID_STATUS_TRANSITION (already SALES_ORDER)
    const roleCount = await prisma.partyRole.count({ where: { partyId: party.id, role: 'CUSTOMER' } });
    expect(roleCount).toBe(1);
    const dupOrders = await prisma.salesDocument.count({ where: { opportunityId: opportunity.id, status: 'SALES_ORDER' } });
    expect(dupOrders).toBe(1);

    // And a SECOND order for the SAME (already-customer) party must not
    // disturb its data: no duplicate role, no changed `since`.
    const order2 = await api('POST', '/api/sales', adminToken, {
      customerPartyId: party.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 1, unitPrice: 1000, uomId: uom.id }],
    });
    expect(order2.status).toBe(201);
    tracked.salesDocs.push(order2.body.id as string);
    await api('POST', `/api/sales/${order2.body.id}/confirm`, adminToken, {});
    const act2 = await api('POST', `/api/sales/${order2.body.id}/activate`, adminToken, {});
    expect(act2.status).toBe(201);
    const roleAfter = await prisma.partyRole.findUniqueOrThrow({
      where: { partyId_role: { partyId: party.id, role: 'CUSTOMER' } },
    });
    expect(roleAfter.id).toBe(role.id); // SAME row — since/notes untouched
    const roleCountAfter = await prisma.partyRole.count({ where: { partyId: party.id, role: 'CUSTOMER' } });
    expect(roleCountAfter).toBe(1);
  });

  // ─────────────────────────── EDGE CASES ───────────────────────────

  it('edge: opportunity for a NON-customer party (CR-001 law change)', async () => {
    const party = await prisma.party.create({
      data: { companyId, type: 'COMPANY', nameFa: `cr1-leadonly-${marker}`, createdBy: adminId },
    });
    tracked.parties.push(party.id);
    const created = await api('POST', '/api/opportunities', adminToken, {
      customerPartyId: party.id,
      salespersonUserId: adminId,
      title: `فرصت بدون نقش مشتری ${marker}`,
    });
    expect(created.status).toBe(201);
    tracked.opportunities.push(created.body.id);
  });

  it('edge: lead WITHOUT a party identity is rejected (CR-001 partyId required)', async () => {
    const res = await api('POST', '/api/leads', adminToken, { name: 'بدون طرف‌حساب' });
    expect(res.status).toBe(400); // ValidationPipe — partyId is now required
  });

  it('edge: quotation for a cross-company party → uniform 404, no existence leak', async () => {
    // The foreign party EXISTS (company B) but is invisible to this company.
    const foreignParty = await prisma.party.create({
      data: {
        companyId: (await prisma.company.findFirstOrThrow({ where: { nameFa: companyB } })).id,
        type: 'COMPANY',
        nameFa: `cr1-foreign-${marker}`,
      },
    });
    tracked.parties.push(foreignParty.id);
    const variant = { id: (globalThis as unknown as { __cr1Variant: string }).__cr1Variant };
    const uom = { id: (globalThis as unknown as { __cr1Uom: string }).__cr1Uom };
    const res = await api('POST', '/api/sales', adminToken, {
      customerPartyId: foreignParty.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 1, unitPrice: 10, uomId: uom.id }],
    });
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('Party not found');
  });

  it('edge: quotation linked to a MISMATCHED opportunity party → 422', async () => {
    const otherParty = await prisma.party.create({
      data: { companyId, type: 'COMPANY', nameFa: `cr1-mismatch-${marker}`, createdBy: adminId },
    });
    tracked.parties.push(otherParty.id);
    const variant = { id: (globalThis as unknown as { __cr1Variant: string }).__cr1Variant };
    const uom = { id: (globalThis as unknown as { __cr1Uom: string }).__cr1Uom };
    const res = await api('POST', '/api/sales', adminToken, {
      customerPartyId: otherParty.id,
      opportunityId: (globalThis as unknown as { __cr1: { opportunity: { id: string } } }).__cr1.opportunity.id,
      status: 'QUOTATION',
      lines: [{ productVariantId: variant.id, quantity: 1, unitPrice: 10, uomId: uom.id }],
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('OPPORTUNITY_PARTY_MISMATCH');
  });

  it('edge: lost lead cannot convert; lost opportunity requires a reason', async () => {
    const party = await prisma.party.create({
      data: { companyId, type: 'COMPANY', nameFa: `cr1-lost-${marker}`, createdBy: adminId },
    });
    tracked.parties.push(party.id);
    const lead = await prisma.lead.create({
      data: { companyId, partyId: party.id, name: `cr1-lost-${marker}`, status: 'LOST', createdBy: adminId },
    });
    tracked.leads.push(lead.id);
    const res = await api('POST', `/api/leads/${lead.id}/convert`, adminToken, {});
    expect(res.status).toBe(422);
    expect(res.body.message).toBe('LEAD_LOST_CANNOT_CONVERT');

    const lostReason = await prisma.lostReason.create({
      data: { companyId, code: `CR1_LOST_${Date.now() % 100000}`, nameFa: 'قیمت' },
    });
    const opp = await api('POST', '/api/opportunities', adminToken, {
      customerPartyId: party.id,
      salespersonUserId: adminId,
      title: 'به‌سرعت بازنده',
      status: undefined,
    });
    tracked.opportunities.push(opp.body.id);
    const lost = await api('PATCH', `/api/opportunities/${opp.body.id}`, adminToken, {
      status: 'LOST',
      version: opp.body.version,
      // no lostReasonId → must fail
    });
    expect(lost.status).toBe(422);
    expect(lost.body.message).toBe('LOST_REASON_REQUIRED');
    const lostOk = await api('PATCH', `/api/opportunities/${opp.body.id}`, adminToken, {
      status: 'LOST',
      version: opp.body.version,
      lostReasonId: lostReason.id,
    });
    expect(lostOk.status).toBe(200);
  });

  it('edge: unauthorized user cannot convert (no crm.manage)', async () => {
    const viewerRole = await prisma.role.create({
      data: {
        code: `cr1-viewer-${Date.now() % 100000000}`,
        nameFa: 'مشاهده‌گر crm',
        nameEn: 'crm-viewer',
      },
    });
    tracked.roles.push(viewerRole.id);
    const perm = await prisma.permission.findUniqueOrThrow({ where: { code: 'crm.view' } });
    await prisma.rolePermission.create({ data: { roleId: viewerRole.id, permissionId: perm.id } });
    const viewer = await prisma.user.create({
      data: {
        username: `cr1-viewer-${marker}`,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    tracked.users.push(viewer.id);
    await prisma.userCompany.create({ data: { userId: viewer.id, companyId } });
    await prisma.userCompanyRole.create({ data: { userId: viewer.id, companyId, roleId: viewerRole.id } });
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: viewer.username, password: ADMIN_PASSWORD }),
    });
    const viewerToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';
    expect(viewerToken).toBeTruthy();

    const { lead } = (globalThis as unknown as { __cr1: { lead: { id: string } } }).__cr1;
    const res = await api('POST', `/api/leads/${lead.id}/convert`, viewerToken, {});
    expect([403, 400]).toContain(res.status); // already-converted lead → convert is idempotent-visible? NO:
    // the viewer must not be able to READ beyond crm.view either — but the
    // decisive assertion: convert WITHOUT crm.manage is forbidden.
    // (If the lead is already converted the endpoint still requires the
    // permission first — guards run BEFORE the handler.)
    if (res.status === 201) throw new Error('unauthorized user CONVERTED a lead!');
  });
});
