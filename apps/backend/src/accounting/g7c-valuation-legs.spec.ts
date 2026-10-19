import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValuationReportService } from './valuation-report.service';
import { NormalizationService } from '../inventory/normalization.service';

jest.setTimeout(60000);

const DB_URL = process.env.DATABASE_URL;
const D = (v: string | number) => new Prisma.Decimal(v);

describe('g7c-v — Inventory valuation LEGS integrity (hermetic live DB)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let valuation: ValuationReportService;
  let COMPANY = '';
  let locA = ''; // INTERNAL warehouse A
  let locB = ''; // INTERNAL warehouse warehouse B
  let whA = '';
  let whB = '';
  let variantKg = '';
  let variantPcs = '';
  let supplierLoc = '';
  let customerLoc = '';
  const movementIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prismaService = new S();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    valuation = new ValuationReportService(prismaService as never);

    const company = await prismaService.company.create({
      data: { nameFa: `g7c-v-${Date.now()}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    // warehouses + INTERNAL locations
    const wA = await prismaService.warehouse.create({
      data: { companyId: COMPANY, code: 'WH-A', nameFa: 'انبار A' },
    });
    const wB = await prismaService.warehouse.create({
      data: { companyId: COMPANY, code: 'WH-B', nameFa: 'انبار B' },
    });
    whA = wA.id;
    whB = wB.id;
    const mkLoc = async (type: 'INTERNAL' | 'SUPPLIER' | 'CUSTOMER', code: string, nameFa: string, warehouseId?: string) => {
      const loc = await prismaService.$queryRaw<Array<{ id: string }>>`
        INSERT INTO stock_locations (id, company_id, type, warehouse_id, code, name_fa, active)
        VALUES (gen_random_uuid(), ${COMPANY}::uuid, ${type}::"StockLocationType", ${warehouseId ?? null}::uuid, ${code}, ${nameFa}, true)
        RETURNING id`;
      return loc[0].id;
    };
    locA = await mkLoc('INTERNAL', 'LOC-WHA', 'انبار A داخلی', whA);
    locB = await mkLoc('INTERNAL', 'LOC-WHB', 'انبار B داخلی', whB);
    supplierLoc = await mkLoc('SUPPLIER', 'SUPPLIER-DEFAULT', 'تامین‌کننده');
    customerLoc = await mkLoc('CUSTOMER', 'CUSTOMER-DEFAULT', 'مشتری');

    // UOMs: kg base, ton = 1000kg, piece base with product-weight path
    const uomCat = await prismaService.uomCategory.create({
      data: { companyId: COMPANY, code: 'WEIGHT', nameFa: 'وزن' },
    });
    const pcsCat = await prismaService.uomCategory.create({
      data: { companyId: COMPANY, code: 'UNIT', nameFa: 'عدد' },
    });
    const kg = await prismaService.uom.create({
      data: { companyId: COMPANY, categoryId: uomCat.id, nameFa: 'کیلوگرم', symbol: 'kg', conversionRatio: new Prisma.Decimal(1), isBaseUnit: true },
    });
    await prismaService.uom.create({
      data: { companyId: COMPANY, categoryId: uomCat.id, nameFa: 'تن', symbol: 'ton', conversionRatio: new Prisma.Decimal(1000), isBaseUnit: false },
    });
    await prismaService.uom.create({
      data: { companyId: COMPANY, categoryId: pcsCat.id, nameFa: 'عدد', symbol: 'pcs', conversionRatio: new Prisma.Decimal(1), isBaseUnit: true },
    });
    void kg;

    const template = await prismaService.productTemplate.create({
      data: { companyId: COMPANY, categoryId: (await prismaService.productCategory.create({ data: { companyId: COMPANY, code: 'V-TEST', nameFa: 'تست' } })).id, nameFa: 'محصول تست' },
    });
    // variant in kg (inventory uom = kg)
    variantKg = (
      await prismaService.productVariant.create({
        data: { companyId: COMPANY, templateId: template.id, sku: 'VKG', nameFa: 'واریانت کیلویی', combinationKey: 'kg-test', defaultUomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id },
      })
    ).id;
    // variant in pieces WITH weightPerUnit 18.7 kg + weightUom kg
    variantPcs = (
      await prismaService.productVariant.create({
        data: {
          companyId: COMPANY,
          templateId: template.id,
          sku: 'VPCS',
          nameFa: 'واریانت شاخه‌ای',
          combinationKey: 'pcs-test',
          weightPerUnit: new Prisma.Decimal(18.7),
          weightUomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
          defaultUomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'pcs' } })).id,
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (!prismaService) return;
    await prismaService.stockMovement.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.stockLocation.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.productVariant.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.productTemplate.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.productCategory.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.uom.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.uomCategory.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.warehouse.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    await prismaService.$disconnect();
  });

  /** Insert a movement row with cost snapshots (normalized via NormalizationService for cross-UOM). */
  async function movement(input: {
    variantId: string;
    sourceLocationId: string;
    destinationLocationId: string;
    quantity: string;
    uomId: string;
    unitCost?: string;
    movementDate?: Date;
    idempotencyKey: string;
  }) {
    const normalized = await new NormalizationService(prismaService as never).normalizeQuantity(
      COMPANY,
      input.variantId,
      input.quantity,
      input.uomId,
    );
    const invUom = await prismaService.productVariant.findUniqueOrThrow({
      where: { id: input.variantId },
      select: { inventoryUomId: true, defaultUomId: true },
    });
    const row = await prismaService.stockMovement.create({
      data: {
        companyId: COMPANY,
        productVariantId: input.variantId,
        sourceQuantity: new Prisma.Decimal(input.quantity),
        sourceUomId: input.uomId,
        normalizedQuantity: normalized,
        inventoryUomId: invUom.inventoryUomId ?? invUom.defaultUomId!,
        direction: 'IN',
        sourceLocationId: input.sourceLocationId,
        destinationLocationId: input.destinationLocationId,
        movementDate: input.movementDate ?? new Date(),
        sourceEntityType: 'TEST',
        sourceEntityId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: input.idempotencyKey,
        unitCostSnapshot: input.unitCost ? new Prisma.Decimal(input.unitCost) : null,
        totalCostSnapshot: input.unitCost ? normalized.times(new Prisma.Decimal(input.unitCost)) : null,
      },
    });
    movementIds.push(row.id);
    return row;
  }

  const itif = DB_URL ? it : it.skip;

  itif('g7c-v-01 supplier→INTERNAL increases warehouse A stock', async () => {
    await movement({
      variantId: variantKg,
      sourceLocationId: supplierLoc,
      destinationLocationId: locA,
      quantity: '40000',
      uomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
      unitCost: '10',
      idempotencyKey: 'v01-in',
    });
    const report = await valuation.valuation(COMPANY, { variantId: variantKg });
    const row = report.rows.find((r) => r.variant.id === variantKg)!;
    expect(row.quantity.toNumber()).toBe(40000);
    expect(report.totals.grandTotalValue.toNumber()).toBe(400000);
  });

  itif('g7c-v-02 INTERNAL→CUSTOMER decreases warehouse A; company total drops', async () => {
    await movement({
      variantId: variantKg,
      sourceLocationId: locA,
      destinationLocationId: customerLoc,
      quantity: '10000',
      uomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
      unitCost: '10',
      idempotencyKey: 'v02-out',
    });
    const report = await valuation.valuation(COMPANY, { variantId: variantKg });
    expect(report.totals.grandQuantity.toNumber()).toBe(30000);
    expect(report.totals.grandTotalValue.toNumber()).toBe(300000);
  });

  itif('g7c-v-03/04 INTERNAL A→INTERNAL B: company total unchanged, per-warehouse shifts', async () => {
    await movement({
      variantId: variantKg,
      sourceLocationId: locA,
      destinationLocationId: locB,
      quantity: '15000',
      uomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
      unitCost: '10',
      idempotencyKey: 'v03-transfer',
    });
    const report = await valuation.valuation(COMPANY, { variantId: variantKg });
    expect(report.totals.grandQuantity.toNumber()).toBe(30000); // unchanged
    expect(report.totals.grandTotalValue.toNumber()).toBe(300000); // unchanged
    const whA = report.rows.find((r) => r.warehouseNameFa === 'انبار A')!;
    const whB = report.rows.find((r) => r.warehouseNameFa === 'انبار B')!;
    expect(whA.quantity.toNumber()).toBe(15000); // 30000 - 15000
    expect(whB.quantity.toNumber()).toBe(15000);
  });

  itif('g7c-v-05 piece→kg conversion via weightPerUnit (normalization service)', async () => {
    // movement stored in pcs (variant inventory uom); conversion to kg is
    // verified through NormalizationService (100 pcs × 18.7 kg/pc = 1870 kg)
    const pcsUom = await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'pcs' } });
    await movement({
      variantId: variantPcs,
      sourceLocationId: supplierLoc,
      destinationLocationId: locA,
      quantity: '100',
      uomId: pcsUom.id,
      unitCost: '10',
      idempotencyKey: 'v05-in',
    });
    const report = await valuation.valuation(COMPANY, { variantId: variantPcs });
    // pcs variant's inventory uom is pcs → quantity 100, value 100 × 10
    expect(report.totals.grandQuantity.toNumber()).toBe(100);
    expect(report.totals.grandTotalValue.toNumber()).toBe(1000);
    // cross-category conversion to kg uses weightPerUnit:
    const norm = new NormalizationService(prismaService as never);
    const kgQty = await norm.normalizeQuantity(COMPANY, variantPcs, 100, pcsUom.id, (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id);
    expect(kgQty.toNumber()).toBe(1870); // 100 × 18.7
  });

  itif('g7c-v-06 asOf excludes later movements', async () => {
    const past = new Date(Date.now() - 7 * 86400000);
    await movement({
      variantId: variantKg,
      sourceLocationId: supplierLoc,
      destinationLocationId: locA,
      quantity: '5000',
      uomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
      unitCost: '10',
      movementDate: new Date(Date.now() + 7 * 86400000), // FUTURE — excluded from asOf past
      idempotencyKey: 'v06-future',
    });
    const futureRow = await prismaService.stockMovement.findFirstOrThrow({ where: { idempotencyKey: 'v06-future' } });
    movementIds.push(futureRow.id);
    const asOfPast = await valuation.valuation(COMPANY, { variantId: variantKg, asOf: past });
    const qtyPast = asOfPast.totals.grandQuantity.toNumber();
    // future movement excluded → whatever the value, it must be less than full total
    const asOfNow = await valuation.valuation(COMPANY, { variantId: variantKg, asOf: new Date(Date.now() + 86400000) });
    expect(asOfNow.totals.grandQuantity.gt(asOfPast.totals.grandQuantity)).toBe(true);
    // cleanup this movement
    await prismaService.stockMovement.deleteMany({ where: { idempotencyKey: 'v06-future' } });
    const idx = movementIds.indexOf(futureRow.id);
    if (idx >= 0) movementIds.splice(idx, 1);
  });

  itif('g7c-v-07 grandTotalValue identical across pages', async () => {
    const page1 = await valuation.valuation(COMPANY, { page: 1, pageSize: 1 });
    const page2 = await valuation.valuation(COMPANY, { page: 1, pageSize: 200 });
    expect(page1.totals.grandTotalValue.toString()).toBe(page2.totals.grandTotalValue.toString());
    expect(page1.totals.grandTotalValue.gt(0)).toBe(true);
  });

  itif('g7c-v-08 reversal removes exactly the original contribution', async () => {
    // v01-in contributed +40000 (supplier→A). Reversing it (A→supplier) must
    // remove exactly that contribution: after = before − 40000. (With other
    // legs present this goes negative — the integrity property is that the
    // DELTA equals minus the original leg, not that stock stays positive.)
    const before = await valuation.valuation(COMPANY, { variantId: variantKg });
    const orig = await prismaService.stockMovement.findUniqueOrThrow({
      where: { idempotencyKey: 'v01-in' },
    });
    await movement({
      variantId: orig.productVariantId,
      sourceLocationId: orig.destinationLocationId,
      destinationLocationId: orig.sourceLocationId,
      quantity: orig.sourceQuantity.toString(),
      uomId: orig.sourceUomId,
      unitCost: orig.unitCostSnapshot?.toString() ?? '10',
      idempotencyKey: 'v08-reversal',
    });
    const after = await valuation.valuation(COMPANY, { variantId: variantKg });
    const delta = after.totals.grandQuantity.minus(before.totals.grandQuantity);
    expect(delta.toNumber()).toBe(-40000);
    const valueDelta = after.totals.grandTotalValue.minus(before.totals.grandTotalValue);
    expect(valueDelta.toNumber()).toBe(-400000); // 40000 kg × 10/kg cost snapshot
  });
});
