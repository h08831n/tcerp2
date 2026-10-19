import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { JournalService } from './journal.service';
import { ReportsService } from './reports.service';
import { SubsidiaryLedgerService } from './subsidiary-ledger.service';
import { ValuationReportService } from './valuation-report.service';
import { ProfitReportService } from './profit-report.service';
import { SequencesService } from '../sequences/sequences.service';
import { AccountingEventService } from './accounting-event.service';
import { describeIntegration, integrationPrisma, disconnectIntegrationPrisma } from '../testing/integration';

jest.setTimeout(90000);

const DB_URL = process.env.DATABASE_URL;
const ACTOR = { id: '00000000-0000-4000-8000-0000000000a1', username: 'admin' };
// High-value + fractional precision amount (beyond float64 safe integer range)
const BIG = '123456789012345.6789';
const BIG_PART = '617228394506172.83945'; // 50% split (exact half of BIG)

describe('g7c-p — Decimal precision across financial reports (hermetic live DB)', () => {
  let prismaService: PrismaService;
  let prisma: PrismaClient;
  let journal: JournalService;
  let reports: ReportsService;
  let subsidiary: SubsidiaryLedgerService;
  let profit: ProfitReportService;
  let valuation: ValuationReportService;
  let COMPANY = '';
  let customerId = '';
  const entryIds: string[] = [];
  let eventIds: string[] = [];

  beforeAll(async () => {
    if (!DB_URL) return;
    const { PrismaService: S } = await import('../prisma/prisma.service');
    prismaService = new S();
    prisma = prismaService as unknown as PrismaClient;
    await prismaService.$connect();
    const audit = new AuditService(prismaService as never);
    journal = new JournalService(prismaService as never, new SequencesService(prismaService as never, audit));
    reports = new ReportsService(prismaService as never);
    subsidiary = new SubsidiaryLedgerService(prismaService as never);
    profit = new ProfitReportService(prismaService as never);
    valuation = new ValuationReportService(prismaService as never);

    const company = await prismaService.company.create({
      data: { nameFa: `g7c-p-${Date.now()}`, status: 'ACTIVE' },
    });
    COMPANY = company.id;
    for (const a of [
      { code: 'BANK', name: 'بانک', type: 'ASSET' as const },
      { code: 'RECEIVABLE', name: 'دریافتنی', type: 'ASSET' as const },
      { code: 'SALES_REVENUE', name: 'درآمد', type: 'REVENUE' as const },
      { code: 'PURCHASE_EXPENSE', name: 'بهای تمام‌شده', type: 'EXPENSE' as const },
      { code: 'INVENTORY', name: 'موجودی', type: 'ASSET' as const },
    ]) {
      await prismaService.chartOfAccount.create({ data: { ...a, companyId: COMPANY } });
    }
    await prismaService.sequence.create({
      data: { companyId: COMPANY, documentType: 'JOURNAL_ENTRY', name: 'سند', prefix: 'JE', padding: 5, resetCycle: 'NEVER' },
    });
    // UOMs for the valuation precision test
    const uomCat = await prismaService.uomCategory.create({
      data: { companyId: COMPANY, code: 'WEIGHT', nameFa: 'وزن' },
    });
    await prismaService.uom.create({
      data: { companyId: COMPANY, categoryId: uomCat.id, nameFa: 'کیلوگرم', symbol: 'kg', conversionRatio: new Prisma.Decimal(1), isBaseUnit: true },
    });
    const customer = await prismaService.party.create({
      data: { companyId: COMPANY, type: 'PERSON', nameFa: 'g7c-p مشتری', roles: { create: [{ role: 'CUSTOMER' }] } },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    if (!prismaService) return;
    // scoped cleanup: our company only
    await prismaService.journalLineAnalytic.deleteMany({ where: { journalLine: { companyId: COMPANY } } });
    await prismaService.journalLine.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.journalEntry.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.accountingEvent.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.chartOfAccount.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.sequence.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.party.deleteMany({ where: { companyId: COMPANY } });
    await prismaService.company.delete({ where: { id: COMPANY } }).catch(() => undefined);
    await prismaService.$disconnect();
  });

  const itif = DB_URL ? it : it.skip;

  itif('g7c-p-TB trial balance carries exact Decimal closing (BIG)', async () => {
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'BANK', debit: BIG, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: BIG },
      ],
    });
    entryIds.push(entry.id);
    const tb = await reports.trialBalance(COMPANY, { asOf: new Date() });
    const bank = tb.rows.find((r) => r.accountCode === 'BANK')!;
    // exact string comparison — no float drift
    expect(bank.closingDebit.toString()).toBe(BIG);
    expect(tb.balanced).toBe(true);
  });

  itif('g7c-p-SL subsidiary ledger exact Decimal (BIG)', async () => {
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'RECEIVABLE', debit: BIG, credit: 0, partyId: customerId },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: BIG },
      ],
    });
    entryIds.push(entry.id);
    const ledger = await subsidiary.partyLedger(COMPANY, customerId, { accountCode: 'RECEIVABLE' });
    const row = ledger.rows.find((r) => r.debit.toString() === BIG)!;
    expect(row).toBeTruthy();
    expect(row.runningBalance.toString()).toBe(BIG);
  });

  itif('g7c-p-PROFIT profit report exact Decimal from event snapshots (BIG split)', async () => {
    // A real posted journal entry — its id becomes the event's sourceEntityId
    // (UUID column) and journalEntryId link.
    const srcEntry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: new Date(),
      journalCode: 'OPERATIONAL',
      documentType: 'SALES_COMPLETED_LOADING',
      lines: [
        { accountCode: 'RECEIVABLE', debit: BIG, credit: 0, partyId: customerId },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: BIG },
      ],
    });
    entryIds.push(srcEntry.id);
    // Two SALES_COMPLETED_LOADING events with BIG revenue and exact-half COGS:
    // revenue 123456789012345.6789, cogs 617228394506172.83945 each? No —
    // COGS total must equal a value whose Decimal math is exact: use BIG/2 ≈
    // 61728394506172.83945 × 2 = 123456789012345.6789 exactly.
    const half = '61728394506172.83945'; // BIG / 2 exactly
    const revenue = BIG;
    for (const variantId of ['variant-A', 'variant-B']) {
      await prismaService.accountingEvent.create({
        data: {
          companyId: COMPANY,
          eventType: 'SALES_COMPLETED_LOADING',
          sourceEntityType: 'sales_document',
          sourceEntityId: srcEntry.id,
          journalEntryId: srcEntry.id,
          payload: {
            measures: {
              RECEIVABLE: revenue,
              REVENUE: revenue,
              COGS: half,
              INVENTORY: half,
            } as unknown as Record<string, string>,
            analytics: { customerId, salespersonUserId: null, productVariantId: variantId },
            reversal: false,
          } as unknown as Prisma.InputJsonValue,
          status: 'POSTED',
          idempotencyKey: `g7c-p:${variantId}`,
        },
      });
      eventIds.push();
    }
    const report = await profit.operationalProfit(COMPANY, { customerId });
    // two events × revenue BIG = 2 × BIG (exact Decimal)
    const expectedRevenue = new Prisma.Decimal(BIG).times(2);
    expect(report.totals.revenue.toString()).toBe(expectedRevenue.toString());
    // COGS = 2 × half = BIG exactly
    expect(report.totals.cogs.toString()).toBe(BIG);
    // gross profit = revenue − cogs = BIG (exact string)
    expect(report.totals.grossProfit.toString()).toBe(BIG);
  });

  itif('g7c-p-VAL inventory valuation exact Decimal from cost snapshots (BIG)', async () => {
    const variant = await prismaService.productVariant.create({
      data: {
        companyId: COMPANY,
        templateId: (
          await prismaService.productTemplate.create({
            data: { companyId: COMPANY, categoryId: (await prismaService.productCategory.create({ data: { companyId: COMPANY, code: 'G7CP', nameFa: 'g7c-p' } })).id, nameFa: 'g7c-p محصول' },
          })
        ).id,
        sku: 'G7CP-1',
        nameFa: 'g7c-p واریانت',
        combinationKey: 'g7c-p-1',
      },
    });
    const wh = await prismaService.warehouse.create({
      data: { companyId: COMPANY, code: 'WH-G7CP', nameFa: 'انبار g7c-p' },
    });
    const loc = await prismaService.$queryRaw<Array<{ id: string }>>`
      INSERT INTO stock_locations (id, company_id, type, warehouse_id, code, name_fa, active)
      VALUES (gen_random_uuid(), ${COMPANY}::uuid, 'INTERNAL'::"StockLocationType", ${wh.id}::uuid, 'LOC-G7CP', 'انبار g7c-p', true)
      RETURNING id`;
    const locId = loc[0].id;
    const supLoc = await prismaService.$queryRaw<Array<{ id: string }>>`
      INSERT INTO stock_locations (id, company_id, type, code, name_fa, active)
      VALUES (gen_random_uuid(), ${COMPANY}::uuid, 'SUPPLIER', 'SUP-G7CP', 'تامین g7c-p', true)
      RETURNING id`;
    const supLocId = supLoc[0].id;
    // IN movement: quantity fits numeric(18,4) (max < 10^14); unit cost 2/kg
    // → total value = 2 × BIG (exact Decimal through the report)
    const QTY = '12345678901234.6789';
    await prismaService.stockMovement.create({
      data: {
        companyId: COMPANY,
        productVariantId: variant.id,
        sourceQuantity: new Prisma.Decimal(QTY),
        sourceUomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
        normalizedQuantity: new Prisma.Decimal(QTY),
        inventoryUomId: (await prismaService.uom.findFirstOrThrow({ where: { companyId: COMPANY, symbol: 'kg' } })).id,
        direction: 'IN',
        sourceLocationId: supLocId,
        destinationLocationId: locId,
        movementDate: new Date(),
        sourceEntityType: 'TEST',
        sourceEntityId: '00000000-0000-4000-8000-000000000001',
        idempotencyKey: `g7c-p:val:in:${Date.now()}`,
        unitCostSnapshot: new Prisma.Decimal('2'),
        totalCostSnapshot: new Prisma.Decimal(BIG).times(2),
      },
    });
    const report = await valuation.valuation(COMPANY, { variantId: variant.id });
    const row = report.rows.find((r) => r.variant.id === variant.id)!;
    expect(row.quantity.toString()).toBe(QTY);
    // total value = QTY × 2 — exact Decimal, no float loss
    expect(row.totalValue.toString()).toBe(new Prisma.Decimal(QTY).times(2).toString());
  });

  itif('g7c-p-REV reversal restores exact Decimal balance', async () => {
    const closingBeforeOriginal = (
      await reports.generalLedger(COMPANY, { accountCode: 'BANK' })
    ).totals.closingBalance;
    const date = new Date();
    const entry = await journal.post(prismaService as never, {
      companyId: COMPANY,
      entryDate: date,
      journalCode: 'GENERAL',
      lines: [
        { accountCode: 'BANK', debit: BIG, credit: 0 },
        { accountCode: 'SALES_REVENUE', debit: 0, credit: BIG },
      ],
    });
    entryIds.push(entry.id);
    const { reversal } = await journal.reverse(entry.id, ACTOR);
    entryIds.push(reversal.id);
    const after = await reports.generalLedger(COMPANY, { accountCode: 'BANK' });
    // net zero: closing after reversal == closing before the original was posted
    // (both original + reversal included, they cancel exactly)
    expect(after.totals.closingBalance.equals(closingBeforeOriginal)).toBe(true);
    // and the reversal's credit is exactly BIG
    const rLines = await prisma.journalLine.findMany({ where: { journalEntryId: reversal.id } });
    const revLine = rLines.find((l) => l.credit.gt(0))!;
    expect(revLine.credit.toString()).toBe(BIG);
  });
});
