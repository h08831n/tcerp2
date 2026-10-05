import { SupplierProductService } from './supplier-product.service';
import {
  describeIntegration,
  disconnectIntegrationPrisma,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
  testUuid,
  TEST_INTEGRATION,
} from '../testing/integration';

/**
 * GATE TEST 10 — supplier product mapping is exactly-one: service rejects
 * mis-shaped rows; with a live DB the CHECK constraint is enforced for raw
 * inserts as well.
 */
describe('10 supplier-product-exact-one', () => {
  const audit = { record: jest.fn() };

  it('VARIANT mapping with an extra FK is rejected by the service', async () => {
    const prisma = { supplierProduct: { create: jest.fn() } };
    const service = new SupplierProductService(prisma as never, audit as never);
    await expect(
      service.create(
        'company-1',
        {
          supplierPartyId: 'supplier-1',
          mappingLevel: 'VARIANT',
          productVariantId: 'variant-1',
          productTemplateId: 'template-1', // extra FK → wrong shape
        },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(prisma.supplierProduct.create).not.toHaveBeenCalled();
  });

  it('VARIANT mapping with no FK is rejected by the service', async () => {
    const prisma = { supplierProduct: { create: jest.fn() } };
    const service = new SupplierProductService(prisma as never, audit as never);
    await expect(
      service.create(
        'company-1',
        { supplierPartyId: 'supplier-1', mappingLevel: 'VARIANT' },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('TEMPLATE mapping requires only productTemplateId', async () => {
    const prisma = {
      supplierProduct: {
        create: jest.fn(async (args: { data: object }) => ({ id: 'sp-1', ...args.data })),
      },
    };
    const service = new SupplierProductService(prisma as never, audit as never);
    await expect(
      service.create(
        'company-1',
        {
          supplierPartyId: 'supplier-1',
          mappingLevel: 'TEMPLATE',
          productTemplateId: 'template-1',
        },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).resolves.toBeTruthy();
  });

  it('CATEGORY mapping with a variant instead is rejected', async () => {
    const prisma = { supplierProduct: { create: jest.fn() } };
    const service = new SupplierProductService(prisma as never, audit as never);
    await expect(
      service.create(
        'company-1',
        {
          supplierPartyId: 'supplier-1',
          mappingLevel: 'CATEGORY',
          productVariantId: 'variant-1',
        },
        { id: 'u1', username: 'admin' },
        {},
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  describeIntegration('integration (live DB enforces the CHECK)', () => {
    const prisma = integrationPrisma();
    const partyIds: string[] = [];

    afterAll(async () => {
      if (partyIds.length > 0) {
        await prisma.supplierProduct.deleteMany({
          where: { companyId: INTEGRATION_COMPANY_ID, supplierPartyId: { in: partyIds } },
        });
      }
      await disconnectIntegrationPrisma();
    });

    it('a raw INSERT violating the CHECK throws', async () => {
      if (!TEST_INTEGRATION) return;
      const partyId = testUuid();
      partyIds.push(partyId);
      await expect(
        prisma.$executeRaw`
          INSERT INTO "supplier_products"
            ("id", "company_id", "supplier_party_id", "mapping_level", "product_variant_id", "product_template_id", "category_id", "created_at", "updated_at")
          VALUES (gen_random_uuid(), ${INTEGRATION_COMPANY_ID}::uuid, ${partyId}::uuid, 'VARIANT'::"SupplierMappingLevel", gen_random_uuid(), gen_random_uuid(), NULL, now(), now())
        `,
      ).rejects.toThrow(/supplier_products_exactly_one_level_chk/);
    });

    it('a raw INSERT matching the CHECK succeeds', async () => {
      if (!TEST_INTEGRATION) return;
      const partyId = testUuid();
      partyIds.push(partyId);
      await expect(
        prisma.$executeRaw`
          INSERT INTO "supplier_products"
            ("id", "company_id", "supplier_party_id", "mapping_level", "product_variant_id", "created_at", "updated_at")
          VALUES (gen_random_uuid(), ${INTEGRATION_COMPANY_ID}::uuid, ${partyId}::uuid, 'VARIANT'::"SupplierMappingLevel", gen_random_uuid(), now(), now())
        `,
      ).resolves.toBe(1);
    });
  });
});
