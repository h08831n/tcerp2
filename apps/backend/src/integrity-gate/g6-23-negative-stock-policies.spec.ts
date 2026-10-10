import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId } from '../testing/p4-fixtures';
import { createCompany } from '../testing/p5-fixtures';
import { inventoryService, cleanupCompanyPhase6, stockQuery } from '../testing/p6-fixtures';
import { NormalizationService, NEGATIVE_STOCK_POLICY_SETTING } from '../inventory/normalization.service';
import { createVariantEx, seededUoms } from './g6-helpers';

/**
 * g6-23 — negative-stock-policies: `inventory.negative_stock_policy` is
 * ALLOW | WARN | BLOCK (default WARN). WARN/ALLOW let an INTERNAL location go
 * negative (flagged on the stock query); BLOCK rejects the write at the
 * movement seam (NEGATIVE_STOCK_BLOCKED) BEFORE any row is written.
 */
describeIntegration('g6-23 negative-stock-policies', () => {
  const prisma = integrationPrisma();
  const marker = `g6-23-${Date.now()}`;
  let actorId = '';
  let companyBId = '';
  let variantId = '';

  beforeAll(async () => {
    actorId = await adminUserId(prisma);
    const companyB = await createCompany(prisma, marker);
    companyBId = companyB.id;
  });

  it('default (no setting) = WARN; BLOCK rejects; ALLOW lets it slide', async () => {
    const actor = { id: actorId, username: 'admin' };
    const inventory = inventoryService(prisma);
    const normalization = new NormalizationService(prisma as never);

    // Company B: its own weight category (kg base) + a variant.
    const category = await prisma.uomCategory.create({
      data: { companyId: companyBId, code: `W-${marker}`, nameFa: 'وزن' },
    });
    const kg = await prisma.uom.create({
      data: { companyId: companyBId, categoryId: category.id, symbol: 'kg', nameFa: 'کیلوگرم', conversionRatio: '1', isBaseUnit: true },
    });
    const variant = await createVariantEx(prisma, `${marker}-b`, {
      companyId: companyBId,
      defaultUomId: kg.id,
      inventoryUomId: kg.id,
    });
    variantId = variant.variantId;

    const main = await inventory.ensureDefaultWarehouse(prisma as never, companyBId);
    const other = await inventory.createWarehouse(
      companyBId,
      { code: 'SECOND', nameFa: 'انبار دوم' },
      actor,
      {},
    );

    // No setting → default WARN: the drain below zero is allowed and flagged
    // (per-warehouse view — the company total of an internal transfer is 0).
    expect(await normalization.negativeStockPolicy(companyBId)).toBe('WARN');
    await inventory.transfer(
      companyBId,
      { variantId, quantity: 10, uomId: kg.id, fromWarehouseId: main.id, toWarehouseId: other.id },
      actor,
      {},
    );
    const warnStock = await inventory.stock(companyBId, stockQuery({ warehouseId: main.id }));
    const warnRow = warnStock.items[0] as { stock: { toString(): string }; negative: boolean };
    expect(Number(warnRow.stock)).toBe(-10); // MAIN went negative under WARN
    expect(warnRow.negative).toBe(true);

    // ALLOW: explicitly permitted, same behavior, still flagged.
    await prisma.setting.upsert({
      where: { companyId_key: { companyId: companyBId, key: NEGATIVE_STOCK_POLICY_SETTING } },
      create: { companyId: companyBId, key: NEGATIVE_STOCK_POLICY_SETTING, value: 'ALLOW', category: 'inventory' },
      update: { value: 'ALLOW' },
    });
    expect(await normalization.negativeStockPolicy(companyBId)).toBe('ALLOW');
    await expect(
      inventory.transfer(
        companyBId,
        { variantId, quantity: 5, uomId: kg.id, fromWarehouseId: main.id, toWarehouseId: other.id },
        actor,
        {},
      ),
    ).resolves.toBeTruthy();

    // BLOCK: the write is rejected AT THE SEAM and nothing is written.
    await prisma.setting.upsert({
      where: { companyId_key: { companyId: companyBId, key: NEGATIVE_STOCK_POLICY_SETTING } },
      create: { companyId: companyBId, key: NEGATIVE_STOCK_POLICY_SETTING, value: 'BLOCK', category: 'inventory' },
      update: { value: 'BLOCK' },
    });
    expect(await normalization.negativeStockPolicy(companyBId)).toBe('BLOCK');
    const movementsBefore = await prisma.stockMovement.count({ where: { companyId: companyBId } });
    await expect(
      inventory.transfer(
        companyBId,
        { variantId, quantity: 100, uomId: kg.id, fromWarehouseId: main.id, toWarehouseId: other.id },
        actor,
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 422, message: 'NEGATIVE_STOCK_BLOCKED' });
    expect(await prisma.stockMovement.count({ where: { companyId: companyBId } })).toBe(movementsBefore);

    // BLOCK still permits a drain the location CAN cover (other has 15).
    await expect(
      inventory.transfer(
        companyBId,
        { variantId, quantity: 15, uomId: kg.id, fromWarehouseId: other.id, toWarehouseId: main.id },
        actor,
        {},
      ),
    ).resolves.toBeTruthy();
  });

  afterAll(async () => {
    await cleanupCompanyPhase6(prisma, companyBId);
    await disconnectIntegrationPrisma();
  });
});
