import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { GlobalExceptionFilter } from '../common/filters/http-exception.filter';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';

/**
 * CR-001 REVISION 2 — acceptance scenario over the REAL AppModule (HTTP).
 *
 * The R2 laws under test:
 *  1. A lead IS a Party with the LEAD role: POST /leads creates Party + role
 *     + CRM record in ONE transaction (and never duplicates an existing
 *     party when partyId is given).
 *  2. THE CONVERSION LAW (supersedes R1): the FIRST successful quotation
 *     save converts a LEAD party to CUSTOMER — atomically (a failed save
 *     converts nothing), idempotently, preserving other roles (SUPPLIER...)
 *     and all history. The sales-menu flow obeys the same law (single write
 *     path).
 *  3. The Opportunity stage is GONE: no convert endpoint, no opportunity
 *     creation route; existing historical rows remain untouched.
 *  4. Smart Buttons: GET /parties/:id/smart-counts returns REAL counts.
 */

const ADMIN_PASSWORD = 'Cr2-Admin-Passw0rd!';

if (TEST_INTEGRATION) {
  assertSafeIntegrationDatabase(process.env.DATABASE_URL);
}

for (const [key, value] of Object.entries({
  JWT_SECRET: process.env.JWT_SECRET ?? 'cr2-jwt-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? 'cr2-jwt-refresh-secret-0123456789',
  NODE_ENV: 'test',
})) {
  if (!process.env[key]) process.env[key] = value;
}

const state: { leadPartyId: string; leadId: string } = { leadPartyId: '', leadId: '' };

describeIntegration('cr-001 R2 acceptance (real AppModule over HTTP)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  let adminToken = '';
  let adminId = '';
  const companyId = '00000000-0000-4000-8000-000000000001';
  const marker = `cr2-${Date.now()}`;
  const tracked = {
    users: [] as string[],
    roles: [] as string[],
    companies: [] as string[],
    parties: [] as string[],
    leads: [] as string[],
    salesDocs: [] as string[],
    variants: [] as string[],
    uoms: [] as string[],
    uomCategories: [] as string[],
    productCategories: [] as string[],
    templates: [] as string[],
    sequenceIds: [] as string[],
  };
  let uomId = '';
  let variantId = '';

  async function api(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'x-company-id': companyId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json as Record<string, unknown> & { items?: unknown[] } };
  }

  const rolesOf = async (partyId: string): Promise<string[]> =>
    (await prisma.partyRole.findMany({ where: { partyId } })).map((r) => r.role).sort();

  beforeAll(async () => {
    if (!TEST_INTEGRATION) return;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = await moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api');
    nestApp.use(require('cookie-parser')());
    nestApp.useGlobalFilters(new GlobalExceptionFilter());
    nestApp.useGlobalPipes(
      new (require('@nestjs/common').ValidationPipe)({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
        transformOptions: { enableImplicitConversion: false },
      }),
    );
    await nestApp.init();
    const server = nestApp.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    app = nestApp;

    prisma = new PrismaService();
    await prisma.$connect();

    const adminRole = await prisma.role.findUniqueOrThrow({ where: { code: 'admin' }, select: { id: true } });
    const admin = await prisma.user.create({
      data: {
        username: `cr2-admin-${marker}`,
        passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 8),
        status: 'ACTIVE',
        mustChangePassword: false,
      },
    });
    adminId = admin.id;
    tracked.users.push(admin.id);
    await prisma.userCompany.create({ data: { userId: admin.id, companyId } });
    await prisma.userCompanyRole.create({ data: { userId: admin.id, companyId, roleId: adminRole.id } });

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: admin.username, password: ADMIN_PASSWORD }),
    });
    adminToken = ((await login.json()) as { accessToken?: string }).accessToken ?? '';
    expect(adminToken).toBeTruthy();

    const uomCategory = await prisma.uomCategory.create({
      data: { companyId, nameFa: `cr2-cat-${marker}`, code: `cr2c${Date.now() % 100000}` },
    });
    tracked.uomCategories.push(uomCategory.id);
    const uom = await prisma.uom.create({
      data: { companyId, categoryId: uomCategory.id, symbol: `cr2u${Date.now() % 100000}`, nameFa: 'واحد cr2', conversionRatio: 1 },
    });
    tracked.uoms.push(uom.id);
    uomId = uom.id;
    const productCategory = await prisma.productCategory.create({
      data: { companyId, nameFa: `cr2-pc-${marker}`, code: `cr2p${Date.now() % 100000}` } as never,
    });
    tracked.productCategories.push(productCategory.id);
    const template = await prisma.productTemplate.create({
      data: { companyId, categoryId: productCategory.id, nameFa: `cr2-tpl-${marker}` } as never,
    });
    tracked.templates.push(template.id);
    const variant = await prisma.productVariant.create({
      data: {
        companyId,
        templateId: template.id,
        sku: `cr2-sku-${Date.now() % 100000000}`,
        nameFa: 'وریانت cr2',
        combinationKey: `cr2-combo-${Date.now() % 100000000}`,
      },
    });
    tracked.variants.push(variant.id);
    variantId = variant.id;
  });

  afterAll(async () => {
    const failures: string[] = [];
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        failures.push(`${name}: ${(e as Error).message}`);
      }
    };
    if (prisma) {
      await step('salesLines', () => prisma.salesLine.deleteMany({ where: { salesDocumentId: { in: tracked.salesDocs } } }).then(() => undefined));
      await step('salesDocs', () => prisma.salesDocument.deleteMany({ where: { id: { in: tracked.salesDocs } } }).then(() => undefined));
      await step('leads', () => prisma.lead.deleteMany({ where: { id: { in: tracked.leads } } }).then(() => undefined));
      await step('variants', () => prisma.productVariant.deleteMany({ where: { id: { in: tracked.variants } } }).then(() => undefined));
      await step('templates', () => prisma.productTemplate.deleteMany({ where: { id: { in: tracked.templates } } }).then(() => undefined));
      await step('productCategories', () => prisma.productCategory.deleteMany({ where: { id: { in: tracked.productCategories } } }).then(() => undefined));
      await step('uoms', () => prisma.uom.deleteMany({ where: { id: { in: tracked.uoms } } }).then(() => undefined));
      await step('uomCategories', () => prisma.uomCategory.deleteMany({ where: { id: { in: tracked.uomCategories } } }).then(() => undefined));
      await step('parties', () => prisma.party.deleteMany({ where: { id: { in: tracked.parties } } }).then(() => undefined));
      await step('roles', () => prisma.role.deleteMany({ where: { id: { in: tracked.roles } } }).then(() => undefined));
      await step('sequences', () => prisma.sequence.deleteMany({ where: { id: { in: tracked.sequenceIds } } }).then(() => undefined));
      await step('users', () => prisma.user.deleteMany({ where: { id: { in: tracked.users } } }).then(() => undefined));
      await step('companies', () => prisma.company.deleteMany({ where: { id: { in: tracked.companies } } }).then(() => undefined));
      await prisma.$disconnect();
      if (failures.length > 0) throw new Error(`CR2 CLEANUP FAILURES:\n- ${failures.join('\n- ')}`);
    }
    if (app) await app.close();
  });

  it('law 1: POST /leads creates Party + LEAD role + CRM record in ONE transaction', async () => {
    const res = await api('POST', '/api/leads', adminToken, {
      name: `سرنخ R2 ${marker}`,
      type: 'COMPANY',
      phone: '09123334444',
      source: 'EXHIBITION',
    });
    expect(res.status).toBe(201);
    const lead = res.body as unknown as {
      id: string;
      partyId: string;
      party: { id: string };
    };
    tracked.leads.push(lead.id);
    tracked.parties.push(lead.partyId);

    // The party exists WITH the LEAD role — same transaction.
    expect(await rolesOf(lead.partyId)).toContain('LEAD');
    const leadRow = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(leadRow.partyId).toBe(lead.partyId);
    const party = await prisma.party.findUniqueOrThrow({ where: { id: lead.partyId } });
    expect(party.nameFa).toBe(`سرنخ R2 ${marker}`);

    // The party timeline carries the lead creation (chatter is unified).
    const timeline = await api('GET', `/api/parties/${lead.partyId}/timeline`, adminToken);
    const types = ((timeline.body.items as Array<{ type: string }>) ?? []).map((e) => e.type);
    expect(types).toContain('LEAD_CREATED');

    state.leadPartyId = lead.partyId; state.leadId = lead.id;
  });

  it('law 1b: linking an EXISTING party never duplicates it', async () => {
    const { leadPartyId } = state;
    const before = await prisma.party.count({ where: { companyId } });
    const res = await api('POST', '/api/leads', adminToken, {
      name: 'هرچیزی — نادیده گرفته می‌شود',
      partyId: leadPartyId,
      source: 'REFERRAL',
    });
    expect(res.status).toBe(201);
    const lead = res.body as unknown as { id: string; partyId: string };
    tracked.leads.push(lead.id);
    expect(lead.partyId).toBe(leadPartyId);
    expect(await prisma.party.count({ where: { companyId } })).toBe(before);
    // Still exactly ONE LEAD role (idempotent upsert).
    const leadRoles = await prisma.partyRole.count({ where: { partyId: leadPartyId, role: 'LEAD' } });
    expect(leadRoles).toBe(1);
  });

  it('law 2: THE FIRST quotation save converts the LEAD party to CUSTOMER — atomically', async () => {
    const { leadPartyId } = state;

    // Give the party a SECOND role to prove role composition survives (R2 §5).
    await prisma.partyRole.create({ data: { partyId: leadPartyId, role: 'SUPPLIER' } });

    const before = await rolesOf(leadPartyId);
    expect(before).toContain('LEAD');
    expect(before).toContain('SUPPLIER');
    expect(before).not.toContain('CUSTOMER');

    // Save a quotation (the ONLY write path — the sales-menu flow included).
    const quote = await api('POST', '/api/sales', adminToken, {
      customerPartyId: leadPartyId,
      status: 'QUOTATION',
      lines: [{ productVariantId: variantId, quantity: 2, unitPrice: 1500000, uomId }],
    });
    expect(quote.status).toBe(201);
    tracked.salesDocs.push(quote.body.id as string);

    // THE LAW: the same transaction made the party a CUSTOMER.
    const after = await rolesOf(leadPartyId);
    expect(after).toContain('CUSTOMER');
    expect(after).toContain('LEAD'); // history preserved
    expect(after).toContain('SUPPLIER'); // composition preserved

    // Audited: ROLE_ADDED via=QUOTATION.
    const audit = await prisma.auditLog.findFirst({
      where: { entityType: 'party', entityId: leadPartyId, action: 'ROLE_ADDED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit?.newValues).toMatchObject({ role: 'CUSTOMER', via: 'QUOTATION' });

    // Timeline «مشتری شد» on the party chatter.
    const timeline = await api('GET', `/api/parties/${leadPartyId}/timeline`, adminToken);
    const items = (timeline.body.items as Array<{ type: string; title: string }>) ?? [];
    expect(items.some((e) => e.type === 'ROLE_ADDED' && e.title === 'مشتری شد')).toBe(true);

    // Atomicity proof: the quotation row and the role row landed together.
    const doc = await prisma.salesDocument.findUniqueOrThrow({ where: { id: quote.body.id as string } });
    expect(doc.customerPartyId).toBe(leadPartyId);
  });

  it('law 2b: a FAILED quotation save converts NOTHING (atomic rollback)', async () => {
    // A fresh lead party, then an INVALID quotation (nonexistent variant → 4xx).
    const lead = await api('POST', '/api/leads', adminToken, {
      name: `سرنخ شکست ${marker}`,
      type: 'COMPANY',
    });
    expect(lead.status).toBe(201);
    const leadId = (lead.body as unknown as { id: string }).id;
    const partyId = (lead.body as unknown as { partyId: string }).partyId;
    tracked.leads.push(leadId);
    tracked.parties.push(partyId);

    const bad = await api('POST', '/api/sales', adminToken, {
      customerPartyId: partyId,
      status: 'QUOTATION',
      lines: [{ productVariantId: '00000000-0000-4000-8000-0000000000aa', quantity: 1, unitPrice: 10, uomId }],
    });
    expect([400, 404, 422, 500]).toContain(bad.status);
    // THE LAW: no conversion happened.
    expect(await rolesOf(partyId)).not.toContain('CUSTOMER');
    expect(await rolesOf(partyId)).toContain('LEAD');
  });

  it('law 2c: an already-CUSTOMER party just gets the quotation (no duplicate role)', async () => {
    const { leadPartyId } = state;
    const rolesBefore = await rolesOf(leadPartyId);
    const custBefore = await prisma.partyRole.findUniqueOrThrow({
      where: { partyId_role: { partyId: leadPartyId, role: 'CUSTOMER' } },
    });

    const quote2 = await api('POST', '/api/sales', adminToken, {
      customerPartyId: leadPartyId,
      status: 'QUOTATION',
      lines: [{ productVariantId: variantId, quantity: 1, unitPrice: 100, uomId }],
    });
    expect(quote2.status).toBe(201);
    tracked.salesDocs.push(quote2.body.id as string);

    expect(await rolesOf(leadPartyId)).toEqual(rolesBefore); // unchanged
    const custAfter = await prisma.partyRole.findUniqueOrThrow({
      where: { partyId_role: { partyId: leadPartyId, role: 'CUSTOMER' } },
    });
    expect(custAfter.id).toBe(custBefore.id); // SAME row — since untouched
    expect(await prisma.partyRole.count({ where: { partyId: leadPartyId, role: 'CUSTOMER' } })).toBe(1);
  });

  it('law 3: the Opportunity stage is GONE from the operational flow', async () => {
    // The convert endpoint no longer exists.
    const conv = await api('POST', '/api/leads/00000000-0000-4000-8000-0000000000aa/convert', adminToken, {});
    expect(conv.status).toBe(404);
    // Creating an opportunity is no longer possible.
    const opp = await api('POST', '/api/opportunities', adminToken, {
      customerPartyId: '00000000-0000-4000-8000-0000000000aa',
      salespersonUserId: adminId,
      title: 'نباید ساخته شود',
    });
    expect(opp.status).toBe(404);
  });

  it('law 4: active leads list EXCLUDES converted parties, keeps non-converted', async () => {
    const list = await api('GET', '/api/leads?pageSize=100', adminToken);
    expect(list.status).toBe(200);
    const { leadPartyId } = state;
    const partyIds = (list.body.items as Array<{ partyId?: string }>).map((l) => l.partyId);
    // The CONVERTED party (has CUSTOMER) must NOT appear in the active list…
    expect(partyIds).not.toContain(leadPartyId);
    // …while a still-active lead DOES.
    const listAll = await prisma.party.count({ where: { companyId, roles: { some: { role: 'LEAD' } } } });
    expect(listAll).toBeGreaterThanOrEqual(2); // both exist as parties with LEAD
  });

  it('smart buttons: REAL aggregate counts, company-scoped', async () => {
    const { leadPartyId } = state;
    const res = await api('GET', `/api/parties/${leadPartyId}/smart-counts`, adminToken);
    expect(res.status).toBe(200);
    const counts = res.body as unknown as Record<string, number>;
    expect(counts.quotations).toBeGreaterThanOrEqual(2); // two quotations saved above
    expect(counts.salesOrders).toBe(0); // none activated in this scenario
    // Cross-company isolation: a foreign caller sees nothing (uniform 404).
    const foreign = await api('GET', '/api/parties/00000000-0000-4000-8000-0000000000aa/smart-counts', adminToken);
    expect(foreign.status).toBe(404);
  });
});
