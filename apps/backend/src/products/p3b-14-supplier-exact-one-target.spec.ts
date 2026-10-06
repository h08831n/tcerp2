import { assertExactlyOneLevel } from './supplier-mappings.service';
import { SupplierMappingsService } from './supplier-mappings.service';
import { ValidationError } from '../common/errors';

/**
 * p3b-14 — supplier-exact-one-target: the mapping level must match EXACTLY
 * ONE target FK — two targets (or zero) are rejected in the service AND by
 * the DB CHECK supplier_products_exactly_one_level_chk (integration below).
 */
describe('p3b-14 supplier-exact-one-target (unit)', () => {
  const base = {
    supplierPartyId: 'party-1',
    mappingLevel: 'VARIANT' as const,
  };

  it('level VARIANT with variant AND template set → rejected', () => {
    expect(() =>
      assertExactlyOneLevel({
        ...base,
        productVariantId: 'var-1',
        productTemplateId: 'tpl-1',
      }),
    ).toThrow(ValidationError);
  });

  it('level VARIANT with all three targets set → rejected', () => {
    expect(() =>
      assertExactlyOneLevel({
        ...base,
        productVariantId: 'var-1',
        productTemplateId: 'tpl-1',
        categoryId: 'cat-1',
      }),
    ).toThrow(ValidationError);
  });

  it('level VARIANT with no target at all → rejected', () => {
    expect(() => assertExactlyOneLevel({ ...base })).toThrow(ValidationError);
  });

  it('level VARIANT with a MISMATCHED single target (template) → rejected', () => {
    expect(() =>
      assertExactlyOneLevel({ ...base, productTemplateId: 'tpl-1' }),
    ).toThrow(ValidationError);
  });

  it('level VARIANT with exactly productVariantId → accepted', () => {
    expect(() =>
      assertExactlyOneLevel({ ...base, productVariantId: 'var-1' }),
    ).not.toThrow();
  });

  it('level TEMPLATE with exactly productTemplateId → accepted', () => {
    expect(() =>
      assertExactlyOneLevel({
        supplierPartyId: 'party-1',
        mappingLevel: 'TEMPLATE',
        productTemplateId: 'tpl-1',
      }),
    ).not.toThrow();
  });

  it('the service create path rejects a two-target payload before any query', async () => {
    const prisma = {
      party: { findUnique: jest.fn() },
      $transaction: jest.fn(),
    };
    const service = new SupplierMappingsService(prisma as never, { recordTx: jest.fn() } as never);
    await expect(
      service.create(
        'company-1',
        {
          supplierPartyId: 'party-1',
          mappingLevel: 'VARIANT',
          productVariantId: 'var-1',
          categoryId: 'cat-1',
        },
        { id: 'u1', username: 'buyer' },
        {},
      ),
    ).rejects.toMatchObject({ message: 'SUPPLIER_MAPPING_EXACTLY_ONE_LEVEL' });
    expect(prisma.party.findUnique).not.toHaveBeenCalled();
  });
});

import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
  testUuid,
} from '../testing/integration';

describeIntegration('p3b-14 supplier-exact-one-target (live DB CHECK)', () => {
  const prisma = integrationPrisma();
  const marker = Date.now();
  let partyId: string;
  let categoryId: string;

  beforeAll(async () => {
    const party = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        type: 'COMPANY',
        nameFa: `تامین‌کننده چک کُر۱۴ ${marker}`,
        roles: { create: { role: 'SUPPLIER' } },
      },
    });
    partyId = party.id;
    const category = await prisma.productCategory.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `CHK-${marker}`,
        nameFa: 'دسته چک',
      },
    });
    categoryId = category.id;
  });

  it('the DB CHECK supplier_products_exactly_one_level_chk rejects two targets', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO supplier_products
          (id, company_id, supplier_party_id, mapping_level, product_variant_id, product_template_id, category_id, created_at, updated_at)
        VALUES
          (${testUuid()}::uuid, ${INTEGRATION_COMPANY_ID}::uuid, ${partyId}::uuid, 'VARIANT',
           ${testUuid()}::uuid, ${testUuid()}::uuid, ${categoryId}::uuid, now(), now())
      `,
    ).rejects.toThrow(/supplier_products_exactly_one_level_chk/);
  });

  it('a single correct target passes the CHECK', async () => {
    await expect(
      prisma.$executeRaw`
        INSERT INTO supplier_products
          (id, company_id, supplier_party_id, mapping_level, category_id, created_at, updated_at)
        VALUES
          (${testUuid()}::uuid, ${INTEGRATION_COMPANY_ID}::uuid, ${partyId}::uuid, 'CATEGORY',
           ${categoryId}::uuid, now(), now())
      `,
    ).resolves.toBe(1);
  });

  afterAll(async () => {
    await prisma.supplierProduct.deleteMany({ where: { supplierPartyId: partyId } });
    await prisma.party.deleteMany({ where: { id: partyId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await disconnectIntegrationPrisma();
  });
});
