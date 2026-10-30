import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ReportsService } from './reports.service';
import {
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { adminUserId, createSalesDocumentRow } from '../testing/p5-fixtures';
import { createParty } from '../testing/p4-fixtures';
import {
  createVariantEx,
  ensureMainWarehouse,
  seededUoms,
} from '../integrity-gate/g6-helpers';

jest.setTimeout(180000);

/**
 * g10 — Phase 10 (Gate F) management reports. The company is SHARED, so every
 * count assertion is a RELATIVE delta (before vs after creating this spec's
 * rows) or filters to this spec's markers.
 */
describeIntegration('g10 management reports (Phase 10)', () => {
  let prisma: PrismaClient;
  const marker = `g10-${Date.now()}`;
  let service: ReportsService;
  let prismaService: PrismaService;
  let actorId = '';
  let variantId = '';
  let uomId = '';
  const partyIds: string[] = [];
  const salesDocIds: string[] = [];
  const purchaseDocIds: string[] = [];
  const grnIds: string[] = [];
  const movementIds: string[] = [];

  const cleanup = async () => {
    await prisma.loadingAllocation.deleteMany({ where: { loadingLine: { loading: { companyId: INTEGRATION_COMPANY_ID, loadingDate: { gte: new Date(2026, 0, 1) } }, notes: marker } } }).catch(() => undefined);
    await prisma.loadingLine.deleteMany({ where: { loading: { notes: marker } } }).catch(() => undefined);
    await prisma.loading.deleteMany({ where: { notes: marker } }).catch(() => undefined);
    await prisma.goodsReceiptLine.deleteMany({ where: { goodsReceiptId: { in: grnIds } } }).catch(() => undefined);
    await prisma.goodsReceipt.deleteMany({ where: { id: { in: grnIds } } }).catch(() => undefined);
    await prisma.purchaseLine.deleteMany({ where: { purchaseDocumentId: { in: purchaseDocIds } } }).catch(() => undefined);
    await prisma.purchaseDocument.deleteMany({ where: { documentNumber: { startsWith: `P10PD-${marker}` } } }).catch(() => undefined);
    await prisma.salesLine.deleteMany({ where: { salesDocumentId: { in: salesDocIds } } }).catch(() => undefined);
    await prisma.salesDocument.deleteMany({ where: { id: { in: salesDocIds } } }).catch(() => undefined);
    await prisma.stockMovement.deleteMany({ where: { id: { in: movementIds } } }).catch(() => undefined);
    await prisma.stockLocation.deleteMany({ where: { companyId: INTEGRATION_COMPANY_ID, code: { startsWith: `G10-${marker}` } } }).catch(() => undefined);
    await prisma.party.deleteMany({ where: { id: { in: partyIds } } }).catch(() => undefined);
    await prisma.productVariant.deleteMany({ where: { id: variantId } }).catch(() => undefined);
  };

  beforeAll(async () => {
    prismaService = new PrismaService();
    await prismaService.$connect();
    prisma = prismaService as unknown as PrismaClient;
    service = new ReportsService(prismaService);
    actorId = await adminUserId(prisma);
    const uoms = await seededUoms(prisma);
    uomId = uoms.tonId;
    const variant = await createVariantEx(prisma, marker, {
      defaultUomId: uoms.tonId,
      inventoryUomId: uoms.tonId,
    });
    variantId = variant.variantId;
  });

  afterAll(async () => {
    await cleanup();
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  async function makeParty(name: string, roles: Array<'CUSTOMER' | 'SUPPLIER'> = ['CUSTOMER']): Promise<string> {
    const party = await prisma.party.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        type: 'COMPANY',
        nameFa: name,
        roles: { create: roles.map((role) => ({ role })) },
      },
      select: { id: true },
    });
    partyIds.push(party.id);
    return party.id;
  }

  async function salesLineFor(documentId: string, price: number) {
    return prisma.salesLine.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        salesDocumentId: documentId,
        productVariantId: variantId,
        orderedQuantity: new Prisma.Decimal(10),
        uomId,
        unitPrice: new Prisma.Decimal(price),
        subtotal: new Prisma.Decimal(price * 10),
        lineTotal: new Prisma.Decimal(price * 10),
      },
      select: { id: true },
    });
  }

  it('g10-01 dashboard: sales/purchase/loadings/inactive sections move by the expected deltas', async () => {
    const before = await service.dashboard(INTEGRATION_COMPANY_ID);
    const customer = await makeParty(`g10 مشتری داشبورد ${marker}`);
    const supplier = await makeParty(`g10 تأمین‌کننده داشبورد ${marker}`, ['SUPPLIER']);

    // one COMPLETED sale this month, one open order
    const completed = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${marker}-cmp`,
      customerPartyId: customer,
      salespersonUserId: actorId,
      status: 'COMPLETED',
      documentDate: new Date(),
    });
    await prisma.salesDocument.update({
      where: { id: completed.id },
      data: { total: new Prisma.Decimal(5000000) },
    });
    salesDocIds.push(completed.id);
    const openOrder = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${marker}-open`,
      customerPartyId: customer,
      salespersonUserId: actorId,
      status: 'SALES_ORDER',
      documentDate: new Date(),
    });
    await prisma.salesDocument.update({
      where: { id: openOrder.id },
      data: { total: new Prisma.Decimal(1200000) },
    });
    salesDocIds.push(openOrder.id);

    // one open purchase order
    const purchase = await prisma.purchaseDocument.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        documentNumber: `P10PD-${marker}-1`,
        supplierPartyId: supplier,
        buyerUserId: actorId,
        documentDate: new Date(),
        status: 'ORDER_PLACED',
        total: new Prisma.Decimal(3000000),
      },
      select: { id: true },
    });
    purchaseDocIds.push(purchase.id);

    // one CONFIRMED loading today with restricted driver info
    await prisma.loading.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        loadingDate: new Date(),
        status: 'CONFIRMED',
        driverInfoRestricted: true,
        notes: marker,
      },
    });

    const after = await service.dashboard(INTEGRATION_COMPANY_ID);
    expect(after.sales.openOrders).toBe(before.sales.openOrders + 1);
    expect(after.sales.openOrderTotal).toBeCloseTo(before.sales.openOrderTotal + 1200000, 4);
    expect(after.sales.completedThisMonth).toBeGreaterThanOrEqual(before.sales.completedThisMonth + 1);
    expect(after.purchase.openOrders).toBe(before.purchase.openOrders + 1);
    expect(after.purchase.openOrderTotal).toBeCloseTo(before.purchase.openOrderTotal + 3000000, 4);
    expect(after.loadings.todayCount).toBe(before.loadings.todayCount + 1);
    expect(after.loadings.pendingDriverRelease).toBe(before.loadings.pendingDriverRelease + 1);
  });

  it('g10-02 sales-performance: per-salesperson split + delivered qty via CONFIRMED allocations', async () => {
    const customer = await makeParty(`g10 مشتری عملکرد ${marker}`);
    const salesperson = await prisma.user.create({
      data: { username: `g10-sales-${Date.now()}`, passwordHash: 'x', status: 'ACTIVE' },
      select: { id: true },
    });
    const completed = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${marker}-perf`,
      customerPartyId: customer,
      salespersonUserId: salesperson.id,
      status: 'COMPLETED',
      documentDate: new Date(),
    });
    await prisma.salesDocument.update({
      where: { id: completed.id },
      data: { total: new Prisma.Decimal(7000000) },
    });
    salesDocIds.push(completed.id);
    const quotation = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${marker}-perf-q`,
      customerPartyId: customer,
      salespersonUserId: salesperson.id,
      status: 'QUOTATION',
      documentDate: new Date(),
    });
    await prisma.salesDocument.update({
      where: { id: quotation.id },
      data: { total: new Prisma.Decimal(1000000) },
    });
    salesDocIds.push(quotation.id);

    // delivered: CONFIRMED loading → line → allocation → sales line → doc
    const loading = await prisma.loading.create({
      data: { companyId: INTEGRATION_COMPANY_ID, loadingDate: new Date(), status: 'CONFIRMED', notes: marker },
      select: { id: true },
    });
    const line = await salesLineFor(completed.id, 700000);
    const loadingLine = await prisma.loadingLine.create({
      data: { loadingId: loading.id, productVariantId: variantId, actualQuantity: new Prisma.Decimal(10), uomId },
      select: { id: true },
    });
    await prisma.loadingAllocation.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        loadingLineId: loadingLine.id,
        salesLineId: line.id,
        allocatedQuantity: new Prisma.Decimal(10),
      },
    });

    const rows = await service.salesPerformance(INTEGRATION_COMPANY_ID);
    const mine = rows.find((r) => r.userId === salesperson.id);
    expect(mine).toBeDefined();
    expect(mine!.completedCount).toBe(1);
    expect(mine!.completedTotal).toBeCloseTo(7000000, 4);
    expect(mine!.openQuotations).toBe(1);
    expect(mine!.openQuotationTotal).toBeCloseTo(1000000, 4);
    expect(mine!.deliveredQty).toBeCloseTo(10, 4);
  });

  it('g10-03 purchase-performance: per-supplier split + received qty from CONFIRMED GRNs', async () => {
    const supplier = await makeParty(`g10 تأمین‌کننده عملکرد ${marker}`, ['SUPPLIER']);
    const purchase = await prisma.purchaseDocument.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        documentNumber: `P10PD-${marker}-2`,
        supplierPartyId: supplier,
        buyerUserId: actorId,
        documentDate: new Date(),
        status: 'COMPLETED',
        total: new Prisma.Decimal(2000000),
      },
      select: { id: true },
    });
    purchaseDocIds.push(purchase.id);
    const purchaseLine = await prisma.purchaseLine.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        purchaseDocumentId: purchase.id,
        productVariantId: variantId,
        orderedQuantity: new Prisma.Decimal(20),
        uomId,
        unitPrice: new Prisma.Decimal(100000),
        lineTotal: new Prisma.Decimal(2000000),
      },
      select: { id: true },
    });
    const internalLoc = await prisma.stockLocation.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `G10-${marker}-GRN`,
        nameFa: 'انبار رسید g10',
        type: 'INTERNAL',
        warehouseId: (await ensureMainWarehouse(prisma)).id,
      },
      select: { id: true },
    });
    const receipt = await prisma.goodsReceipt.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        receiptNumber: `P10GRN-${marker}`,
        purchaseDocumentId: purchase.id,
        destinationLocationId: internalLoc.id,
        receiptDate: new Date(),
        status: 'CONFIRMED',
        notes: marker,
      },
      select: { id: true },
    });
    grnIds.push(receipt.id);
    await prisma.goodsReceiptLine.create({
      data: {
        goodsReceiptId: receipt.id,
        purchaseLineId: purchaseLine.id,
        actualQuantity: new Prisma.Decimal(14),
        uomId,
      },
    });

    const rows = await service.purchasePerformance(INTEGRATION_COMPANY_ID);
    const mine = rows.find((r) => r.partyId === supplier);
    expect(mine).toBeDefined();
    expect(mine!.ordersCount).toBe(1);
    expect(mine!.orderedTotal).toBeCloseTo(2000000, 4);
    expect(mine!.completedTotal).toBeCloseTo(2000000, 4);
    expect(mine!.receivedQty).toBeCloseTo(14, 4);
  });

  it('g10-04 inactive-customers: old-purchase and never-purchase listed, active customer absent', async () => {
    // Isolated company: the shared company's accumulated never-purchased
    // customers exceed the report's 200-row cap, which would hide this
    // spec's rows. The invariant needs a deterministic scope.
    const company = await prisma.company.create({
      data: { nameFa: `g10-inactive-${Date.now()}`, status: 'ACTIVE' },
      select: { id: true },
    });
    try {
      const mk = async (name: string): Promise<string> => {
        const party = await prisma.party.create({
          data: {
            companyId: company.id,
            type: 'COMPANY',
            nameFa: name,
            roles: { create: [{ role: 'CUSTOMER' }] },
          },
          select: { id: true },
        });
        partyIds.push(party.id);
        return party.id;
      };
      const oldCustomer = await mk('g10 غیرفعال ایزوله');
      const activeCustomer = await mk('g10 فعال ایزوله');
      const neverCustomer = await mk('g10 هرگز خریدار ایزوله');
      const salesperson = (await prisma.user.findFirst({ select: { id: true } }))!;
      const old = await createSalesDocumentRow(prisma, company.id, {
        marker: `${marker}-iso-old`,
        customerPartyId: oldCustomer,
        salespersonUserId: salesperson.id,
        status: 'COMPLETED',
        documentDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000),
      });
      salesDocIds.push(old.id);
      await createSalesDocumentRow(prisma, company.id, {
        marker: `${marker}-iso-fresh`,
        customerPartyId: activeCustomer,
        salespersonUserId: salesperson.id,
        status: 'COMPLETED',
        documentDate: new Date(),
      }).then((row) => salesDocIds.push(row.id));

      const rows = await service.inactiveCustomers(company.id);
      const ids = rows.map((r) => r.partyId);
      expect(ids).toContain(oldCustomer);
      expect(ids).toContain(neverCustomer);
      expect(ids).not.toContain(activeCustomer);
      const mine = rows.find((r) => r.partyId === oldCustomer)!;
      expect(mine.daysSinceLastPurchase).toBeGreaterThanOrEqual(119);
      expect(rows.find((r) => r.partyId === neverCustomer)!.daysSinceLastPurchase).toBeNull();
    } finally {
      await prisma.salesDocument.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
      await prisma.party.deleteMany({ where: { companyId: company.id } }).catch(() => undefined);
      await prisma.company.delete({ where: { id: company.id } }).catch(() => undefined);
    }
  });

  it('g10-05 pending-orders: only orders older than the window, with totals over the whole set', async () => {
    const customer = await makeParty(`g10 معوق ${marker}`);
    const oldOrder = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${marker}-stale`,
      customerPartyId: customer,
      salespersonUserId: actorId,
      status: 'SALES_ORDER',
      documentDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    });
    await prisma.salesDocument.update({
      where: { id: oldOrder.id },
      data: { total: new Prisma.Decimal(2500000) },
    });
    salesDocIds.push(oldOrder.id);
    const fresh = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${marker}-fresh-order`,
      customerPartyId: customer,
      salespersonUserId: actorId,
      status: 'SALES_ORDER',
      documentDate: new Date(),
    });
    salesDocIds.push(fresh.id);

    const report = await service.pendingOrders(INTEGRATION_COMPANY_ID, 7);
    const ids = report.items.map((i) => i.documentId);
    expect(ids).toContain(oldOrder.id);
    expect(ids).not.toContain(fresh.id);
    const mine = report.items.find((i) => i.documentId === oldOrder.id)!;
    expect(mine.ageDays).toBeGreaterThanOrEqual(29);
    expect(mine.total).toBeCloseTo(2500000, 4);
    // totals computed over the WHOLE filtered set (not the 50-item page)
    expect(report.totalAmount).toBeGreaterThanOrEqual(2500000);
  });

  it('g10-06 negative-stock: OUT beyond IN shows negative balance; balanced variant absent', async () => {
    const main = await ensureMainWarehouse(prisma);
    const internal = await prisma.stockLocation.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `G10-${marker}-INT`,
        nameFa: 'انبار داخلی g10',
        type: 'INTERNAL',
        warehouseId: main.id,
      },
      select: { id: true },
    });
    const supplier = await prisma.stockLocation.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `G10-${marker}-SUP`,
        nameFa: 'تأمین‌کننده g10',
        type: 'SUPPLIER',
      },
      select: { id: true },
    });
    const customer = await prisma.stockLocation.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        code: `G10-${marker}-CUS`,
        nameFa: 'مشتری g10',
        type: 'CUSTOMER',
      },
      select: { id: true },
    });
    const move = async (
      direction: 'IN' | 'OUT',
      qty: number,
      from: string,
      to: string,
      tag: string,
    ) => {
      const row = await prisma.stockMovement.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          productVariantId: variantId,
          sourceQuantity: new Prisma.Decimal(qty),
          sourceUomId: uomId,
          normalizedQuantity: new Prisma.Decimal(qty),
          inventoryUomId: uomId,
          direction,
          sourceLocationId: from,
          destinationLocationId: to,
          warehouseId: main.id,
          movementDate: new Date(),
          sourceEntityType: 'LOADING',
          sourceEntityId: internal.id,
          idempotencyKey: `g10-${tag}-${Date.now()}-${Math.random()}`,
        },
        select: { id: true },
      });
      movementIds.push(row.id);
    };
    // +100 in, then −150 out → balance −50
    await move('IN', 100, supplier.id, internal.id, 'in');
    await move('OUT', 150, internal.id, customer.id, 'out');

    const rows = await service.negativeStock(INTEGRATION_COMPANY_ID);
    const mine = rows.find((r) => r.variantId === variantId);
    expect(mine).toBeDefined();
    expect(mine!.balance).toBeCloseTo(-50, 4);
  });

  it('g10-07 global search: finds party/variant/document by fragment, scoped to the company', async () => {
    const needle = `گ10-${Date.now()}`;
    const party = await makeParty(`شرکت ${needle}`);
    const customer = await makeParty(`مشتری ${needle}`);
    const doc = await createSalesDocumentRow(prisma, INTEGRATION_COMPANY_ID, {
      marker: `${needle}-doc`,
      customerPartyId: customer,
      salespersonUserId: actorId,
      status: 'SALES_ORDER',
      documentDate: new Date(),
    });
    salesDocIds.push(doc.id);

    const results = await service.globalSearch(INTEGRATION_COMPANY_ID, needle);
    expect(results.parties.map((p) => p.id)).toContain(party);
    expect(results.salesDocuments.map((d) => d.id)).toContain(doc.id);

    // short term rejected
    await expect(service.globalSearch(INTEGRATION_COMPANY_ID, 'ا')).rejects.toMatchObject({
      message: 'REPORT_SEARCH_TERM_TOO_SHORT',
    });
    // company isolation: a DIFFERENT company with the same fragment sees nothing of ours
    const other = await prisma.company.create({
      data: { nameFa: `g10-other-${Date.now()}`, status: 'ACTIVE' },
      select: { id: true },
    });
    try {
      const isolated = await service.globalSearch(other.id, needle);
      expect(isolated.parties).toHaveLength(0);
      expect(isolated.salesDocuments).toHaveLength(0);
    } finally {
      await prisma.company.delete({ where: { id: other.id } }).catch(() => undefined);
    }
  });

  it('g10-08 reports.view seeded: permission exists and manager roles hold it', async () => {
    const permission = await prisma.permission.findUniqueOrThrow({
      where: { code: 'reports.view' },
      select: { id: true },
    });
    const roles = await prisma.role.findMany({
      where: {
        code: {
          in: ['admin', 'sales_manager', 'purchase_manager', 'accountant', 'financial_manager', 'salesperson', 'buyer'],
        },
      },
      select: { id: true, code: true, permissions: { select: { permissionId: true } } },
    });
    // The seed MATERIALIZES 'ALL' as explicit rows for admin — every listed
    // role must hold reports.view.
    for (const code of ['admin', 'sales_manager', 'purchase_manager', 'accountant', 'financial_manager']) {
      const role = roles.find((r) => r.code === code)!;
      expect(role.permissions.some((p) => p.permissionId === permission.id)).toBe(true);
    }
    // Operational roles must NOT see management reports.
    for (const code of ['salesperson', 'buyer']) {
      const role = roles.find((r) => r.code === code);
      if (role) {
        expect(role.permissions.some((p) => p.permissionId === permission.id)).toBe(false);
      }
    }
  });
});
