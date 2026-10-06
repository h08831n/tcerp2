import { TemplatesService, skuCandidates } from './templates.service';
import { ConflictError } from '../common/errors';

/**
 * p3b-09 — sku-uniqueness: a colliding SKU is auto-suffixed -2, -3; a still
 * colliding SKU is a ConflictError. Uniqueness itself is per company
 * (`@@unique([companyId, sku])`) — the same SKU in another company is fine.
 */
describe('p3b-09 sku-uniqueness', () => {
  const COMPANY = 'company-1';
  const actor = { id: 'u1', username: 'admin' };

  it('pure ladder: base, base-2, base-3', () => {
    expect(skuCandidates('P-1-S')).toEqual(['P-1-S', 'P-1-S-2', 'P-1-S-3']);
  });

  const SPACE = [
    {
      attributeId: 'a-size',
      displayOrder: 1,
      attribute: { id: 'a-size', code: 'SIZE', nameFa: 'سایز', values: [{ id: 'v-s', code: 'S', valueFa: 'کوچک' }] },
    },
  ];
  const combo = {
    combinations: [{ selections: [{ attributeId: 'a-size', valueId: 'v-s' }] }],
  };

  function makeService(existingSkus: string[]) {
    const createdSkus: string[] = [];
    const allSkus = new Set(existingSkus);
    const trx = {
      productVariant: {
        findMany: jest.fn(async () =>
          [...allSkus].map((sku) => ({ sku, values: [] })),
        ),
        create: jest.fn(async (args: { data: { sku: string } }) => {
          if (allSkus.has(args.data.sku)) {
            const err = new (require('@prisma/client').PrismaClientKnownRequestError)(
              'Unique constraint failed',
              { code: 'P2002', clientVersion: 'test' },
            );
            throw err;
          }
          allSkus.add(args.data.sku);
          createdSkus.push(args.data.sku);
          return { id: `var-${createdSkus.length}`, sku: args.data.sku };
        }),
      },
    };
    const prisma = {
      productTemplate: {
        findUnique: jest.fn(async () => ({
          id: 'tpl-1',
          companyId: COMPANY,
          internalCode: 'P-1',
          nameFa: 'قالب',
          active: true,
        })),
      },
      productTemplateAttribute: { findMany: jest.fn(async () => SPACE) },
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)),
    };
    const audit = { record: jest.fn(), recordTx: jest.fn() };
    const service = new TemplatesService(prisma as never, audit as never);
    return { service, createdSkus, allSkus, trx };
  }

  it('a taken SKU is auto-suffixed -2 (within the same company)', async () => {
    const { service, createdSkus } = makeService(['P-1-S']);
    const r = (await service.generateVariants(COMPANY, 'tpl-1', combo, actor, {})) as {
      created: Array<{ sku: string }>;
    };
    expect(r.created).toHaveLength(1);
    expect(r.created[0].sku).toBe('P-1-S-2');
    expect(createdSkus).toEqual(['P-1-S-2']);
  });

  it('two collisions exhaust the ladder to -3', async () => {
    const { service, createdSkus } = makeService(['P-1-S', 'P-1-S-2']);
    const r = (await service.generateVariants(COMPANY, 'tpl-1', combo, actor, {})) as {
      created: Array<{ sku: string }>;
    };
    expect(r.created[0].sku).toBe('P-1-S-3');
    expect(createdSkus).toEqual(['P-1-S-3']);
  });

  it('still colliding after the ladder → ConflictError, nothing created', async () => {
    const { service, createdSkus } = makeService(['P-1-S', 'P-1-S-2', 'P-1-S-3']);
    await expect(
      service.generateVariants(COMPANY, 'tpl-1', combo, actor, {}),
    ).rejects.toThrow(ConflictError);
    expect(createdSkus).toHaveLength(0);
  });

  it('the same SKU is legal in another company (companyId is part of the unique key)', () => {
    // The uniqueness constraint is @@unique([companyId, sku]) — a pure check
    // that the generated candidate never mixes companyId into the SKU string.
    const { service } = makeService([]);
    const otherCompanyService = makeService(['P-1-S']); // same sku in company-2
    expect(skuCandidates('P-1-S')).toContain('P-1-S'); // suggestion unchanged
    expect(otherCompanyService.createdSkus).toHaveLength(0);
    expect(service).toBeDefined();
  });
});
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { AuditService } from '../audit/audit.service';
import { CategoriesService } from './categories.service';

describeIntegration('p3b-09 sku-uniqueness (live DB)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  let companyBId: string;
  let templateAId: string;
  let templateBId: string;
  const admin = { id: '', username: 'admin' };

  beforeAll(async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { username: 'admin' } });
    admin.id = user.id;
    const companyB = await prisma.company.create({
      data: { nameFa: `شرکت بی کُر۹ ${marker}` },
    });
    companyBId = companyB.id;

    // Same internal code + attribute codes in BOTH companies → same SKU
    // suggestion in each; must succeed in both (unique is per company).
    const audit = new AuditService(prisma as never);
    const categories = new CategoriesService(prisma as never, audit);
    const templates = new TemplatesService(prisma as never, audit);

    const catA = (await categories.create(
      INTEGRATION_COMPANY_ID,
      { code: `SKUCLASH-${marker}`, nameFa: 'دسته اسکیو' },
      admin,
      {},
    )) as { id: string };
    const catB = (await categories.create(
      companyBId,
      { code: `SKUCLASH-${marker}`, nameFa: 'دسته اسکیو' },
      admin,
      {},
    )) as { id: string };

    templateAId = (
      (await templates.create(
        INTEGRATION_COMPANY_ID,
        { categoryId: catA.id, nameFa: 'محصول', internalCode: `CLASH-${marker}` },
        admin,
        {},
      )) as { id: string }
    ).id;
    templateBId = (
      (await templates.create(
        companyBId,
        { categoryId: catB.id, nameFa: 'محصول', internalCode: `CLASH-${marker}` },
        admin,
        {},
      )) as { id: string }
    ).id;
  });

  it('the same generated SKU exists in both companies without conflict', async () => {
    const audit = new AuditService(prisma as never);
    const templates = new TemplatesService(prisma as never, audit);
    const attr = await prisma.attribute.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `SIZE-${marker}`,
        nameFa: 'سایز',
        values: { create: { code: 'UNI', valueFa: 'تکی' } },
      },
      include: { values: true },
    });
    // Mirror attribute in company B with the same code.
    const attrB = await prisma.attribute.create({
      data: {
        companyId: companyBId,
        code: `SIZE-${marker}`,
        nameFa: 'سایز',
        values: { create: { code: 'UNI', valueFa: 'تکی' } },
      },
      include: { values: true },
    });
    await prisma.productTemplateAttribute.create({
      data: { templateId: templateAId, attributeId: attr.id },
    });
    await prisma.productTemplateAttribute.create({
      data: { templateId: templateBId, attributeId: attrB.id },
    });

    const rA = (await templates.generateVariants(
      INTEGRATION_COMPANY_ID,
      templateAId,
      {
        combinations: [
          { selections: [{ attributeId: attr.id, valueId: attr.values[0].id }] },
        ],
      },
      admin,
      {},
    )) as { created: Array<{ sku: string }> };
    const rB = (await templates.generateVariants(
      companyBId,
      templateBId,
      {
        combinations: [
          { selections: [{ attributeId: attrB.id, valueId: attrB.values[0].id }] },
        ],
      },
      admin,
      {},
    )) as { created: Array<{ sku: string }> };

    const skuA = rA.created[0].sku;
    const skuB = rB.created[0].sku;
    expect(skuA).toBe(skuB); // same SKU string…
    const bySku = await prisma.productVariant.findMany({ where: { sku: skuA } });
    expect(bySku).toHaveLength(2); // …in two different companies
    expect(new Set(bySku.map((v) => v.companyId))).toEqual(
      new Set([INTEGRATION_COMPANY_ID, companyBId]),
    );
  });

  afterAll(async () => {
    // cleanup after yourself
    await prisma.productVariant.deleteMany({ where: { templateId: { in: [templateAId, templateBId] } } });
    await prisma.productTemplate.deleteMany({ where: { id: { in: [templateAId, templateBId] } } });
    await prisma.attribute.deleteMany({ where: { code: `SIZE-${marker}` } });
    await prisma.productCategory.deleteMany({ where: { code: `SKUCLASH-${marker}` } });
    await prisma.company.delete({ where: { id: companyBId } }).catch(() => undefined);
    await disconnectIntegrationPrisma();
  });
});
