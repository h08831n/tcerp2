import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { describeIntegration, TEST_INTEGRATION } from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';
import * as bcrypt from 'bcryptjs';

// CI has NO .env file: the zod-validated config requires these before any
// Nest instantiation. DATABASE_URL comes from the integration runner.
for (const [key, value] of Object.entries({
  JWT_SECRET: 'gate-c-http-jwt-secret-0123456789',
  JWT_REFRESH_SECRET: 'gate-c-http-jwt-refresh-secret-0123456789',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
})) {
  if (!process.env[key]) process.env[key] = value;
}

jest.setTimeout(300_000);
const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

/**
 * GATE C — REAL HTTP security probes: the full AppModule is compiled and
 * initialized with its genuine guards (JwtAuthGuard, PermissionsGuard,
 * CompanyContextService) and driven over a REAL listening socket with
 * native fetch (no supertest dependency).
 *
 * Scenarios: unauthenticated 401; non-member 403; member-without-permission
 * 403; two-company member via x-company-id + foreign-id 404; OWN/TEAM/ALL
 * record scope (CRM + sales); variant/bank-account UPDATE cross-company;
 * cross-company reference exact error + controlled success; export scoping.
 */
describeIntegration('gate-c HTTP (real AppModule + guards)', () => {
  let prisma: PrismaService;
  let app: INestApplication | null = null;
  let baseUrl = '';
  const A_MARKER = `gchA-${Date.now()}`;
  const B_MARKER = `gchB-${Date.now()}`;
  let A = '';
  let B = '';
  const PASSWORD = 'GateC-HTTP-passw0rd!';
  const usernames = {
    all: `gch-all-${A_MARKER}`,
    own: `gch-own-${A_MARKER}`,
    team: `gch-team-${A_MARKER}`,
    noperm: `gch-noperm-${A_MARKER}`,
    none: `gch-none-${A_MARKER}`,
  };
  const tokens: Record<string, string> = {};
  const userIds: Record<string, string> = {};
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  let partyAllA = '';
  let partyOwnA = '';
  let partyTeamA = '';
  let partyB = '';
  let salesOwn = '';
  let salesOther = '';

  async function mkUser(name: keyof typeof usernames, companies: string[], permissionCodes: string[]): Promise<void> {
    const hash = bcrypt.hashSync(PASSWORD, 8);
    const user = await prisma.user.create({
      data: { username: usernames[name], passwordHash: hash, status: 'ACTIVE', mustChangePassword: false, defaultCompanyId: companies[0] ?? null },
    });
    userIds[name] = user.id;
    createdUsers.push(user.id);
    for (const companyId of companies) {
      await prisma.userCompany.create({ data: { userId: user.id, companyId } });
      for (const code of permissionCodes) {
        const permission = await prisma.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
        const role = await prisma.role.create({ data: { code: `gc-${name}-${code.replace(/\./g, '-')}-${companyId.slice(0, 6)}`, nameFa: code, nameEn: code } });
        const rp = await prisma.permission.findUniqueOrThrow({ where: { code }, select: { id: true } });
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: rp.id } });
        await prisma.userCompanyRole.create({ data: { userId: user.id, companyId, roleId: role.id } });
        void permission;
      }
    }
  }

  async function login(name: keyof typeof usernames): Promise<string> {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: usernames[name], password: PASSWORD }),
    });
    const body = (await res.json()) as { accessToken?: string };
    if (!body.accessToken) throw new Error(`login failed for ${name}: ${res.status}`);
    tokens[name] = body.accessToken;
    return body.accessToken;
  }

  function req(name: keyof typeof usernames | null, companyId: string | null, method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(name ? { Authorization: `Bearer ${tokens[name]}` } : {}),
        ...(companyId ? { 'x-company-id': companyId } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  beforeAll(async () => {
    if (!DB_URL) return;
    prisma = new PrismaService();
    await prisma.$connect();
    for (const c of [A_MARKER, B_MARKER]) {
      const company = await prisma.company.create({ data: { nameFa: c, status: 'ACTIVE' } });
      if (A === '') A = company.id;
      else B = company.id;
      createdCompanies.push(company.id);
    }
    for (const companyId of [A, B]) {
      await prisma.chartOfAccount.create({ data: { companyId, code: 'BANK', name: 'بانک', type: 'ASSET' } });
      await prisma.chartOfAccount.create({ data: { companyId, code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' } });
      await prisma.sequence.create({
        data: { companyId, documentType: 'SALES_DOCUMENT', name: 'SD', prefix: 'SD', padding: 5, resetCycle: 'NEVER' },
      });
    }

    const memberBoth = [A, B];
    await mkUser('all', memberBoth, [
      'parties.view', 'parties.create', 'parties.edit', 'parties.scope.all',
      'sales.view', 'sales.create', 'products.view', 'products.variants.manage',
      'treasury.view', 'treasury.edit', 'imports.export', 'accounting.report',
      'accounting.fiscal.manage',
    ]);
    await mkUser('own', [A], ['parties.view', 'parties.create', 'parties.edit', 'sales.view', 'sales.create']);
    await mkUser('team', [A], ['parties.view', 'parties.create', 'parties.edit', 'parties.scope.team', 'sales.view', 'sales.create']);
    await mkUser('noperm', [A], []);
    await mkUser('none', [], []);

    // CRM fixtures with DISTINCT owners for the record-scope matrix.
    partyAllA = (
      await prisma.party.create({
        data: { companyId: A, type: 'COMPANY', nameFa: `own-of-all ${A_MARKER}`, ownerUserId: userIds.all, roles: { create: [{ role: 'CUSTOMER' }] } },
      })
    ).id;
    partyOwnA = (
      await prisma.party.create({
        data: { companyId: A, type: 'COMPANY', nameFa: `own-of-own ${A_MARKER}`, ownerUserId: userIds.own, roles: { create: [{ role: 'CUSTOMER' }] } },
      })
    ).id;
    partyTeamA = (
      await prisma.party.create({
        data: { companyId: A, type: 'COMPANY', nameFa: `own-of-team ${A_MARKER}`, ownerUserId: userIds.team, roles: { create: [{ role: 'CUSTOMER' }] } },
      })
    ).id;
    partyB = (
      await prisma.party.create({
        data: { companyId: B, type: 'COMPANY', nameFa: `party-B ${B_MARKER}`, roles: { create: [{ role: 'CUSTOMER' }] } },
      })
    ).id;

    // Product surface for company A (uom category → uom → category → template
    // → variant) so variant/bank probes have real rows.
    const uomCat = await prisma.uomCategory.create({ data: { companyId: A, code: 'GCH', nameFa: 'گیت سی' } });
    await prisma.uom.create({
      data: { companyId: A, symbol: 'kg', nameFa: 'کیلوگرم', categoryId: uomCat.id, conversionRatio: 1, isBaseUnit: true },
    });
    const cat = await prisma.productCategory.create({ data: { companyId: A, code: 'GCH', nameFa: 'گیت سی' } });
    await prisma.productTemplate.create({
      data: {
        companyId: A, categoryId: cat.id, nameFa: `قالب ${A_MARKER}`,
        variants: { create: { companyId: A, sku: `gchv-${A_MARKER}`, nameFa: 'gc variant', combinationKey: `gch-${A_MARKER}` } },
      },
    });

    // A REAL team containing both `own` and `team` users — the TEAM scope
    // resolves through actual team membership, not company-wide visibility.
    const team = await prisma.team.create({
      data: { companyId: A, name: `gc-team-${A_MARKER}`, members: { create: [{ userId: userIds.own }, { userId: userIds.team }] } },
    });
    void team;

    // Sales documents: one owned (salesperson) by `own`, one by `team`.
    const seqA = await prisma.sequence.create({
      data: { companyId: A, documentType: 'SD-EXTRA', name: 'SD', prefix: 'SDX', padding: 5, resetCycle: 'NEVER' },
    });
    void seqA;
    const mkDoc = async (salespersonId: string, nameFa: string) => {
      const doc = await prisma.salesDocument.create({
        data: {
          companyId: A,
          documentNumber: `SD-${salespersonId.slice(0, 6)}-${Date.now()}`,
          documentDate: new Date(),
          status: 'DRAFT',
          customerPartyId: partyOwnA,
          salespersonUserId: salespersonId,
          version: 1,
          total: 0,
          currency: 'IRR',
          lines: { create: [] },
        },
      });
      return doc.id;
    };
    salesOwn = await mkDoc(userIds.own, 'own-doc');
    salesOther = await mkDoc(userIds.team, 'team-doc');

    // Boot the REAL app on an ephemeral port.
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nestApp = await moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api'); // same as main.ts
    await nestApp.init();
    const server = nestApp.getHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
    app = nestApp;

    for (const name of Object.keys(usernames) as (keyof typeof usernames)[]) {
      tokens[name] = await login(name);
    }
  });

  afterAll(async () => {
    await app?.close().catch(() => undefined);
    if (prisma) {
      for (const companyId of createdCompanies) {
        await prisma.salesLine.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.salesDocument.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.bankAccount.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.party.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.productTemplate.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.productCategory.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.uomCategory.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.timelineEvent.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.auditLog.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.chartOfAccount.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.sequence.deleteMany({ where: { companyId } }).catch(() => undefined);
        await prisma.userPermissionOverride.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => undefined);
        await prisma.userCompanyRole.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => undefined);
        await prisma.userCompany.deleteMany({ where: { userId: { in: createdUsers } } }).catch(() => undefined);
        await prisma.role.deleteMany({ where: { code: { startsWith: 'gc-' } } }).catch(() => undefined);
        await prisma.user.deleteMany({ where: { id: { in: createdUsers } } }).catch(() => undefined);
        await prisma.company.delete({ where: { id: companyId } }).catch(() => undefined);
      }
      await prisma.$disconnect();
    }
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  itif('unauthenticated request → 401', async () => {
    const res = await req(null, A, 'GET', '/api/parties');
    expect(res.status).toBe(401);
  });

  itif('non-member user → 403 (no company context) even with a forged x-company-id', async () => {
    const direct = await req('none', A, 'GET', '/api/parties');
    expect([403, 404]).toContain(direct.status);
    const noHeader = await req('none', null, 'GET', '/api/parties');
    expect(noHeader.status).toBe(403);
  });

  itif('member WITHOUT the permission → 403 (permission guard, server-side)', async () => {
    const res = await req('noperm', A, 'GET', '/api/parties');
    expect(res.status).toBe(403);
    const create = await req('noperm', A, 'POST', '/api/parties', { nameFa: 'x', type: 'COMPANY', roles: ['CUSTOMER'] });
    expect(create.status).toBe(403);
  });

  itif('two-company member: x-company-id switches context; foreign id → 404 never data', async () => {
    const inA = await req('all', A, 'GET', `/api/parties/${partyAllA}`);
    expect(inA.status).toBe(200);
    const inB = await req('all', B, 'GET', `/api/parties/${partyAllA}`);
    expect(inB.status).toBe(404);
    // The B-context party LIST must not contain A's party either.
    const list = (await (await req('all', B, 'GET', '/api/parties?limit=100')).json()) as { items?: Array<{ id: string }> };
    expect((list.items ?? []).some((p) => p.id === partyAllA)).toBe(false);
  });

  itif('CRM record scope: OWN user does not see others; TEAM sees the team; ALL sees everyone', async () => {
    const own = (await (await req('own', A, 'GET', '/api/parties?limit=100')).json()) as { items?: Array<{ id: string }> };
    const ownIds = (own.items ?? []).map((p) => p.id);
    expect(ownIds).toContain(partyOwnA);
    expect(ownIds).not.toContain(partyTeamA);
    expect(ownIds).not.toContain(partyAllA);

    const team = (await (await req('team', A, 'GET', '/api/parties?limit=100')).json()) as { items?: Array<{ id: string }> };
    const teamIds = (team.items ?? []).map((p) => p.id);
    expect(teamIds).toContain(partyTeamA);
    expect(teamIds).toContain(partyOwnA); // same TEAM — visible under TEAM scope
    expect(teamIds).not.toContain(partyAllA);
    expect(teamIds).not.toContain(partyB);

    const all = (await (await req('all', A, 'GET', '/api/parties?limit=100')).json()) as { items?: Array<{ id: string }> };
    const allIds = (all.items ?? []).map((p) => p.id);
    expect(allIds).toContain(partyAllA);
    expect(allIds).not.toContain(partyB);
  });

  itif('Sales record scope mirrors CRM scope permissions', async () => {
    const ownList = (await (await req('own', A, 'GET', '/api/sales?limit=100')).json()) as { items?: Array<{ id: string }> };
    const ownIds = (ownList.items ?? []).map((d) => d.id);
    expect(ownIds).toContain(salesOwn);
    const cross = await req('own', A, 'GET', `/api/sales/${salesOther}`);
    // `own` user reading the TEAM user's document: server decides — OWN scope
    // must NOT return the other user's document.
    expect([404, 403]).toContain(cross.status);
  });

  itif('variant + bank-account UPDATE cross-company → 404', async () => {
    // Variant PATCH route: PATCH /products/templates/:id/variants/:variantId
    const templateId = (await prisma.productTemplate.findFirstOrThrow({ where: { companyId: A } })).id;
    const uomId = (await prisma.uom.findFirstOrThrow({ where: { companyId: A } })).id;
    const variant = await prisma.productVariant.create({
      data: { companyId: A, templateId, sku: `gcv-${Date.now()}`, nameFa: 'gc variant', combinationKey: `gck-${Date.now()}`, defaultUomId: uomId },
    });
    const crossVariant = await req('all', B, 'PATCH', `/api/products/templates/${templateId}/variants/${variant.id}`, { nameFa: 'hacked' });
    expect([404, 403]).toContain(crossVariant.status);

    const account = await prisma.bankAccount.create({
      data: { companyId: A, name: `gc-${A_MARKER}`, bankName: 'Bank A' },
    });
    const cross = await req('all', B, 'PATCH', `/api/treasury/bank-accounts/${account.id}`, { name: 'hacked' });
    expect([404, 403]).toContain(cross.status);
    const ownUpdate = await req('all', A, 'PATCH', `/api/treasury/bank-accounts/${account.id}`, { name: 'renamed-ok' });
    expect([200, 201]).toContain(ownUpdate.status);
    await prisma.productVariant.delete({ where: { id: variant.id } }).catch(() => undefined);
    await prisma.bankAccount.delete({ where: { id: account.id } }).catch(() => undefined);
  });

  itif('cross-company reference: EXACT error + the controlled SUCCESS path', async () => {
    const variantId = (await prisma.productVariant.findFirstOrThrow({ where: { companyId: A } })).id;
    const uomId = (await prisma.uom.findFirstOrThrow({ where: { companyId: A } })).id;
    const bad = await req('all', A, 'POST', '/api/sales', {
      customerPartyId: partyB,
      lines: [{ productVariantId: variantId, quantity: 1, unitPrice: 10, uomId }],
    });
    expect([400, 403, 404, 422]).toContain(bad.status);
    const body = (await bad.json()) as { message?: string };
    // EXACT error recorded for the report.
    // EXACT error recorded: NOT_A_CUSTOMER — assertCustomer does not
    // distinguish "not in this company" from "lacks the CUSTOMER role"
    // (no cross-company existence leak; uniform message).
    expect(body.message).toBe('NOT_A_CUSTOMER');
    // Controlled success: the SAME request with an OWN-company customer → 201.
    const ok = await req('all', A, 'POST', '/api/sales', {
      customerPartyId: partyAllA,
      lines: [{ productVariantId: variantId, quantity: 1, unitPrice: 10, uomId }],
    });
    if (ok.status === 422) {
      throw new Error(`success path 422: ${JSON.stringify(await ok.json())}`);
    }
    expect([200, 201]).toContain(ok.status);
    const okBody = (await ok.json()) as { id?: string };
    if (okBody.id) await prisma.salesDocument.delete({ where: { id: okBody.id } }).catch(() => undefined);
  });

  itif('parties EXPORT is scoped to the x-company-id company', async () => {
    const exportA = await req('all', A, 'GET', '/api/exports/parties.csv');
    expect(exportA.status).toBe(200);
    const text = await exportA.text();
    expect(text).not.toContain('party-B'); // company B's party never leaks
    expect(text).toContain('own-of-all'); // own company's rows present
  });

  itif('sensitive financial op cross-company: opening-balance stage with a foreign fiscal year id', async () => {
    const fyB = await prisma.fiscalYear.create({
      data: { companyId: B, code: 'GCB', nameFa: 'سال B', startDate: new Date('2026-01-01'), endDate: new Date('2026-12-31') },
    });
    await prisma.chartOfAccount.create({ data: { companyId: A, code: 'BANK2', name: 'بانک ۲', type: 'ASSET' } });
    const res = await req('all', A, 'POST', '/api/accounting/opening-balance/stage', {
      rows: [
        { accountCode: 'BANK2', debit: 1 },
        { accountCode: 'OPENING_EQUITY', credit: 1 },
      ],
      fiscalYearId: fyB.id,
    });
    expect([400, 403, 404, 422]).toContain(res.status);
    const text = JSON.stringify(await res.json());
    expect(text).toContain('FISCAL_YEAR_NOT_FOUND');
    await prisma.fiscalYear.delete({ where: { id: fyB.id } }).catch(() => undefined);
  });
});
