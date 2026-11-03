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
  // R6-1: EVERY fixture row's id is tracked so cleanup deletes exactly this
  // run's rows by id (never a prefix/pattern) and the afterAll can PROVE
  // nothing survived.
  const createdUsers: string[] = [];
  const createdCompanies: string[] = [];
  const roleIds: string[] = [];
  const teamIds: string[] = [];
  const uomCategoryIds: string[] = [];
  const uomIds: string[] = [];
  const categoryIds: string[] = [];
  const templateIds: string[] = [];
  const variantIds: string[] = [];
  const partyIds: string[] = [];
  const salesDocIds: string[] = [];
  const bankAccountIds: string[] = [];
  const sequenceIds: string[] = [];
  const chartAccountIds: string[] = [];
  const fiscalYearIds: string[] = [];
  let partyAllA = '';
  let partyOwnA = '';
  let partyTeamA = '';
  let partyB = '';
  let salesOwn = '';
  let salesOther = '';
  let salesOutOfTeam = '';

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
        const role = await prisma.role.create({
          data: {
            code: `gc-${name}-${code.replace(/\./g, '-')}-${companyId.slice(0, 6)}`,
            nameFa: code,
            nameEn: code,
          },
        });
        roleIds.push(role.id); // R6-1: tracked — cleanup deletes THIS row by id
        await prisma.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
        await prisma.userCompanyRole.create({ data: { userId: user.id, companyId, roleId: role.id } });
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
      const bank = await prisma.chartOfAccount.create({ data: { companyId, code: 'BANK', name: 'بانک', type: 'ASSET' } });
      const rev = await prisma.chartOfAccount.create({ data: { companyId, code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' } });
      chartAccountIds.push(bank.id, rev.id);
      const seq = await prisma.sequence.create({
        data: { companyId, documentType: 'SALES_DOCUMENT', name: 'SD', prefix: 'SD', padding: 5, resetCycle: 'NEVER' },
      });
      sequenceIds.push(seq.id);
    }

    const memberBoth = [A, B];
    await mkUser('all', memberBoth, [
      'parties.view', 'parties.create', 'parties.edit', 'parties.scope.all',
      'sales.view', 'sales.create', 'sales.scope.all',
      'products.view', 'products.edit', 'products.variants.manage',
      'treasury.view', 'treasury.edit', 'imports.export', 'accounting.report',
      'accounting.fiscal.manage',
    ]);
    await mkUser('own', [A], ['parties.view', 'parties.create', 'parties.edit', 'sales.view', 'sales.create']);
    await mkUser('team', [A], ['parties.view', 'parties.create', 'parties.edit', 'parties.scope.team', 'sales.view', 'sales.create', 'sales.scope.team']);
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
    partyIds.push(partyAllA, partyOwnA, partyTeamA, partyB);

    // Product surface for company A (uom category → uom → category → template
    // → variant) so variant/bank probes have real rows.
    const uomCat = await prisma.uomCategory.create({ data: { companyId: A, code: 'GCH', nameFa: 'گیت سی' } });
    uomCategoryIds.push(uomCat.id);
    const uom = await prisma.uom.create({
      data: { companyId: A, symbol: 'kg', nameFa: 'کیلوگرم', categoryId: uomCat.id, conversionRatio: 1, isBaseUnit: true },
    });
    uomIds.push(uom.id);
    const cat = await prisma.productCategory.create({ data: { companyId: A, code: 'GCH', nameFa: 'گیت سی' } });
    categoryIds.push(cat.id);
    const template = await prisma.productTemplate.create({
      data: {
        companyId: A, categoryId: cat.id, nameFa: `قالب ${A_MARKER}`,
        variants: { create: { companyId: A, sku: `gchv-${A_MARKER}`, nameFa: 'gc variant', combinationKey: `gch-${A_MARKER}` } },
      },
    });
    templateIds.push(template.id);
    const variant = await prisma.productVariant.findFirstOrThrow({
      where: { companyId: A, templateId: template.id },
      select: { id: true },
    });
    variantIds.push(variant.id);

    // A REAL team containing both `own` and `team` users — the TEAM scope
    // resolves through actual team membership, not company-wide visibility.
    const team = await prisma.team.create({
      data: { companyId: A, name: `gc-team-${A_MARKER}`, members: { create: [{ userId: userIds.own }, { userId: userIds.team }] } },
    });
    teamIds.push(team.id); // R6-1: tracked — TEAM scope resolves REAL membership

    // Sales documents: one owned (salesperson) by `own`, one by `team`.
    const seqA = await prisma.sequence.create({
      data: { companyId: A, documentType: 'SD-EXTRA', name: 'SD', prefix: 'SDX', padding: 5, resetCycle: 'NEVER' },
    });
    sequenceIds.push(seqA.id); // R6-1: tracked (was `void seqA` — leftover bug)
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
    salesOutOfTeam = await mkDoc(userIds.all, 'out-of-team-doc');
    salesDocIds.push(salesOwn, salesOther, salesOutOfTeam);

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
    if (!app && !prisma) return; // unit mode — nothing was booted
    const failures: string[] = [];
    const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
      try {
        await fn();
      } catch (error) {
        // R6-4: cleanup errors are NEVER swallowed — every failure is
        // reported and fails the run.
        failures.push(`${label}: ${String(error)}`);
      }
    };

    // R6-2: dependency-ordered, by-ID cleanup of EXACTLY this run's rows.
    if (prisma) {
      for (const companyId of createdCompanies) {
        await step(`salesLines(${companyId})`, () =>
          prisma.salesLine.deleteMany({ where: { companyId } }));
        await step(`salesDocuments(${companyId})`, () =>
          prisma.salesDocument.deleteMany({ where: { companyId, id: { in: salesDocIds } } }));
        await step(`bankAccounts(${companyId})`, () =>
          prisma.bankAccount.deleteMany({ where: { companyId, id: { in: bankAccountIds } } }));
        await step(`parties(${companyId})`, () =>
          prisma.party.deleteMany({ where: { companyId, id: { in: partyIds } } }));
        await step(`variants(${companyId})`, () =>
          prisma.productVariant.deleteMany({ where: { companyId, id: { in: variantIds } } }));
        await step(`templates(${companyId})`, () =>
          prisma.productTemplate.deleteMany({ where: { companyId, id: { in: templateIds } } }));
        await step(`categories(${companyId})`, () =>
          prisma.productCategory.deleteMany({ where: { companyId, id: { in: categoryIds } } }));
        await step(`uoms(${companyId})`, () =>
          prisma.uom.deleteMany({ where: { companyId, id: { in: uomIds } } }));
        await step(`uomCategories(${companyId})`, () =>
          prisma.uomCategory.deleteMany({ where: { companyId, id: { in: uomCategoryIds } } }));
        await step(`timeline(${companyId})`, () =>
          prisma.timelineEvent.deleteMany({ where: { companyId } }));
        await step(`audit(${companyId})`, () =>
          prisma.auditLog.deleteMany({ where: { companyId } }));
        await step(`chartAccounts(${companyId})`, () =>
          prisma.chartOfAccount.deleteMany({ where: { companyId, id: { in: chartAccountIds } } }));
        await step(`sequences(${companyId})`, () =>
          prisma.sequence.deleteMany({ where: { companyId, id: { in: sequenceIds } } }));
        await step(`fiscalYears(${companyId})`, () =>
          prisma.fiscalYear.deleteMany({ where: { companyId, id: { in: fiscalYearIds } } }));
        // R6-3: roles deleted STRICTLY by tracked id — never a prefix scan.
        await step(`userPermissionOverrides`, () =>
          prisma.userPermissionOverride.deleteMany({ where: { userId: { in: createdUsers } } }));
        await step(`userCompanyRoles`, () =>
          prisma.userCompanyRole.deleteMany({ where: { userId: { in: createdUsers } } }));
        await step(`rolePermissions`, () =>
          prisma.rolePermission.deleteMany({ where: { roleId: { in: roleIds } } }));
        await step(`roles`, () =>
          prisma.role.deleteMany({ where: { id: { in: roleIds } } }));
        await step(`teamMembers+teams`, async () => {
          const members = await prisma.teamMember.deleteMany({ where: { teamId: { in: teamIds } } });
          const teams = await prisma.team.deleteMany({ where: { id: { in: teamIds } } });
          return { members: members.count, teams: teams.count };
        });
        await step(`userCompanies`, () =>
          prisma.userCompany.deleteMany({ where: { userId: { in: createdUsers } } }));
        await step(`users`, () =>
          prisma.user.deleteMany({ where: { id: { in: createdUsers } } }));
        await step(`company(${companyId})`, () =>
          prisma.company.delete({ where: { id: companyId } }));
      }

      // R6-5: PROVE the cleanup — every tracked id space must be empty.
      const leftovers: string[] = [];
      const check = async (label: string, count: number): Promise<void> => {
        if (count !== 0) leftovers.push(`${label}=${count}`);
      };
      for (const companyId of createdCompanies) {
        await check(`companies:${companyId}`, await prisma.company.count({ where: { id: companyId } }));
        await check(`parties:${companyId}`, await prisma.party.count({ where: { companyId, id: { in: partyIds } } }));
        await check(`salesDocs:${companyId}`, await prisma.salesDocument.count({ where: { companyId, id: { in: salesDocIds } } }));
        await check(`bankAccounts:${companyId}`, await prisma.bankAccount.count({ where: { companyId, id: { in: bankAccountIds } } }));
        await check(`templates:${companyId}`, await prisma.productTemplate.count({ where: { companyId, id: { in: templateIds } } }));
        await check(`variants:${companyId}`, await prisma.productVariant.count({ where: { companyId, id: { in: variantIds } } }));
        await check(`uoms:${companyId}`, await prisma.uom.count({ where: { companyId, id: { in: uomIds } } }));
        await check(`uomCategories:${companyId}`, await prisma.uomCategory.count({ where: { companyId, id: { in: uomCategoryIds } } }));
        await check(`chartAccounts:${companyId}`, await prisma.chartOfAccount.count({ where: { companyId, id: { in: chartAccountIds } } }));
        await check(`sequences:${companyId}`, await prisma.sequence.count({ where: { companyId, id: { in: sequenceIds } } }));
        await check(`fiscalYears:${companyId}`, await prisma.fiscalYear.count({ where: { companyId, id: { in: fiscalYearIds } } }));
        await check(`teams:${companyId}`, await prisma.team.count({ where: { id: { in: teamIds } } }));
      }
      await check('users', await prisma.user.count({ where: { id: { in: createdUsers } } }));
      await check('roles', await prisma.role.count({ where: { id: { in: roleIds } } }));
      if (leftovers.length > 0) {
        failures.push(`LEFTOVER ROWS after cleanup: ${leftovers.join(', ')}`);
      }
    }

    await app?.close().catch((error: unknown) => {
      failures.push(`app.close: ${String(error)}`);
    });
    await prisma?.$disconnect().catch((error: unknown) => {
      failures.push(`prisma.disconnect: ${String(error)}`);
    });
    if (failures.length > 0) {
      throw new Error(`GATE-C CLEANUP FAILURES (${failures.length}):\n- ${failures.join('\n- ')}`);
    }
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : it.skip;

  itif('unauthenticated request → 401', async () => {
    const res = await req(null, A, 'GET', '/api/parties');
    expect(res.status).toBe(401);
  });

  itif('non-member user → 403 (no company context) even with a forged x-company-id', async () => {
    // Documented guard ORDER: JwtAuthGuard → PermissionsGuard (lenient
    // company resolution: a non-member resolves NO company → no permission
    // set) → 'Missing required permissions' 403. The controller's
    // requireCompanyId membership assert is a second, defense-in-depth layer.
    const forged = await req('none', A, 'GET', '/api/parties');
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { message?: string }).message).toBe('Missing required permissions');
    const noHeader = await req('none', null, 'GET', '/api/parties');
    expect(noHeader.status).toBe(403);
    expect(((await noHeader.json()) as { message?: string }).message).toBe('Missing required permissions');
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

  itif('Sales record scope mirrors CRM scope permissions (OWN/TEAM/ALL direct access)', async () => {
    const ownList = (await (await req('own', A, 'GET', '/api/sales?limit=100')).json()) as { items?: Array<{ id: string }> };
    const ownIds = (ownList.items ?? []).map((d) => d.id);
    expect(ownIds).toContain(salesOwn);
    // OWN: another user's (same-team) document → 403 assertScope (doc FOUND
    // company-scoped, then scope-rejected — assertSalesInScope throws
    // ForbiddenError, exact status asserted).
    const cross = await req('own', A, 'GET', `/api/sales/${salesOther}`);
    expect(cross.status).toBe(403);
    // OWN: out-of-team document (ALL user's) → 403 as well.
    const outOfTeam = await req('own', A, 'GET', `/api/sales/${salesOutOfTeam}`);
    expect(outOfTeam.status).toBe(403);
    // TEAM: the team-mate's document → 200; the OUT-of-team document → 403.
    const teamMateDoc = await req('team', A, 'GET', `/api/sales/${salesOwn}`);
    expect(teamMateDoc.status).toBe(200);
    const teamBlocked = await req('team', A, 'GET', `/api/sales/${salesOutOfTeam}`);
    expect(teamBlocked.status).toBe(403);
    // ALL: every company-A document → 200 (never company B's).
    const allDoc = await req('all', A, 'GET', `/api/sales/${salesOutOfTeam}`);
    expect(allDoc.status).toBe(200);
  });

  itif('variant + bank-account UPDATE cross-company → 404', async () => {
    // Variant PATCH route: PATCH /products/templates/:id/variants/:variantId
    const templateId = (await prisma.productTemplate.findFirstOrThrow({ where: { companyId: A } })).id;
    const uomId = (await prisma.uom.findFirstOrThrow({ where: { companyId: A } })).id;
    const variant = await prisma.productVariant.create({
      data: { companyId: A, templateId, sku: `gcv-${Date.now()}`, nameFa: 'gc variant', combinationKey: `gck-${Date.now()}`, defaultUomId: uomId },
    });
    variantIds.push(variant.id); // R6-1: tracked — template FK depends on it
    const crossVariant = await req('all', B, 'PATCH', `/api/products/templates/${templateId}/variants/${variant.id}`, { nameFa: 'hacked' });
    expect(crossVariant.status).toBe(404); // company-scoped lookup — exact
    // R6-P2: re-read from the DB and PROVE the unauthorized PATCH changed NOTHING.
    const variantAfter = await prisma.productVariant.findUniqueOrThrow({ where: { id: variant.id } });
    expect(variantAfter.nameFa).toBe('gc variant');

    const account = await prisma.bankAccount.create({
      data: { companyId: A, name: `gc-${A_MARKER}`, bankName: 'Bank A' },
    });
    bankAccountIds.push(account.id);
    const cross = await req('all', B, 'PATCH', `/api/treasury/bank-accounts/${account.id}`, { name: 'hacked' });
    expect(cross.status).toBe(404); // company-scoped lookup — exact
    // R6-P2: DB re-read — the cross-company PATCH must not have renamed.
    const accountAfterCross = await prisma.bankAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(accountAfterCross.name).toBe(`gc-${A_MARKER}`);
    const ownUpdate = await req('all', A, 'PATCH', `/api/treasury/bank-accounts/${account.id}`, { name: 'renamed-ok' });
    expect(ownUpdate.status).toBe(200);
    const accountAfterOwn = await prisma.bankAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(accountAfterOwn.name).toBe('renamed-ok');
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
    fiscalYearIds.push(fyB.id);
    const bank2 = await prisma.chartOfAccount.create({ data: { companyId: A, code: 'BANK2', name: 'بانک ۲', type: 'ASSET' } });
    chartAccountIds.push(bank2.id); // R6-1: tracked
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
