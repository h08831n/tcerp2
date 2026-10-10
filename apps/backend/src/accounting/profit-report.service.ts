import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Operational profit (docs/06 §4): revenue + COGS from the operational
 * accounting journals (SALES_COMPLETED_LOADING / PURCHASE_FULFILLED), never
 * from tax invoices. Dimensions: date, customer, salesperson, variant,
 * supplier.
 */
@Injectable()
export class ProfitReportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Per sales document: revenue = REVENUE-measure credit on the sale journal;
   * COGS = COGS-measure debit on the same journal. Revenue measure lines are
   * identifiable via analytics CUSTOMER + entry documentType.
   */
  async operationalProfit(
    companyId: string,
    opts: { from?: Date; to?: Date; customerId?: string; salespersonUserId?: string; productVariantId?: string },
  ) {
    const dateFilter = {
      ...(opts.from ? { gte: opts.from } : {}),
      ...(opts.to ? { lte: opts.to } : {}),
    };
    const saleEntries = await this.prisma.journalEntry.findMany({
      where: {
        companyId,
        documentType: 'SALES_COMPLETED_LOADING',
        status: 'POSTED',
        ...(Object.keys(dateFilter).length ? { entryDate: dateFilter } : {}),
      },
      select: {
        id: true,
        entryDate: true,
        lines: {
          select: {
            accountId: true,
            debit: true,
            credit: true,
            partyId: true,
            account: { select: { code: true } },
            analytics: { select: { dimensionType: true, dimensionId: true } },
          },
        },
      },
    });
    const eventByJournal = await this.prisma.accountingEvent.findMany({
      where: { companyId, eventType: 'SALES_COMPLETED_LOADING', status: 'POSTED' },
      select: { sourceEntityId: true, journalEntryId: true, payload: true },
    });
    const journalToSales = new Map(eventByJournal.map((e) => [e.journalEntryId, e.sourceEntityId]));

    // Sales doc info (customer/salesperson) — read-only join for dimensions.
    const salesIds = [...new Set(journalToSales.values())].filter((id): id is string => typeof id === 'string');
    const salesDocs = await this.prisma.salesDocument.findMany({
      where: { id: { in: salesIds }, companyId },
      select: {
        id: true,
        documentNumber: true,
        customerPartyId: true,
        salespersonUserId: true,
        customer: { select: { nameFa: true } },
        salesperson: { select: { username: true, firstName: true, lastName: true } },
        lines: { select: { productVariantId: true } },
      },
    });
    const salesById = new Map(salesDocs.map((d) => [d.id, d]));

    const purchaseBySales = await this.prisma.$queryRaw<Array<{ sales_document_id: string; purchase_document_id: string }>>`
      SELECT DISTINCT sa."sales_document_id" AS sales_document_id, pa."purchase_document_id" AS purchase_document_id
      FROM loading_allocations la
      JOIN loading_lines ll ON ll.id = la."loading_line_id"
      JOIN loadings l ON l.id = ll."loading_id"
      JOIN sales_lines sa ON sa.id = la."sales_line_id"
      JOIN purchase_lines pa ON pa.id = la."purchase_line_id"
      WHERE l."company_id" = ${companyId}::uuid AND sa."sales_document_id" IN (${Prisma.join(salesIds.length ? salesIds : ['00000000-0000-0000-0000-000000000000'], ',')}::uuid)`;

    const purchaseMap = new Map(purchaseBySales.map((r) => [r.sales_document_id, r.purchase_document_id]));
    const purchaseIds = [...new Set(purchaseMap.values())];
    const purchaseDocs = await this.prisma.purchaseDocument.findMany({
      where: { id: { in: purchaseIds }, companyId },
      select: {
        id: true,
        documentNumber: true,
        supplierPartyId: true,
        supplier: { select: { nameFa: true } },
      },
    });
    const purchaseById = new Map(purchaseDocs.map((p) => [p.id, p]));

    const rows = [];
    for (const entry of saleEntries) {
      const salesId = journalToSales.get(entry.id);
      if (!salesId) continue;
      const doc = salesById.get(salesId);
      if (!doc) continue;
      if (opts.customerId && doc.customerPartyId !== opts.customerId) continue;
      if (opts.salespersonUserId && doc.salespersonUserId !== opts.salespersonUserId) continue;
      if (opts.productVariantId && !doc.lines.some((l) => l.productVariantId === opts.productVariantId)) continue;

      let revenue = new Prisma.Decimal(0);
      let cogs = new Prisma.Decimal(0);
      for (const line of entry.lines) {
        if (line.account.code === 'SALES_REVENUE') revenue = revenue.plus(line.credit);
        if (line.account.code === 'PURCHASE_EXPENSE' || line.account.code === 'COGS') {
          cogs = cogs.plus(line.debit);
        }
      }
      const purchaseId = purchaseMap.get(salesId) ?? null;
      const purchase = purchaseId ? purchaseById.get(purchaseId) : undefined;
      rows.push({
        salesDocumentId: salesId,
        documentNumber: doc.documentNumber,
        entryDate: entry.entryDate,
        customerId: doc.customerPartyId,
        customerName: doc.customer.nameFa,
        salespersonUserId: doc.salespersonUserId,
        salespersonName:
          [doc.salesperson?.firstName, doc.salesperson?.lastName]
            .filter((p): p is string => typeof p === 'string')
            .join(' ') || doc.salesperson?.username || null,
        purchaseDocumentId: purchaseId ?? null,
        supplierName: purchase?.supplier.nameFa ?? null,
        revenue,
        cogs,
        grossProfit: revenue.minus(cogs),
        marginPct:
          revenue.isZero()
            ? null
            : revenue.minus(cogs).dividedBy(revenue).times(100).toDecimalPlaces(2),
      });
    }
    rows.sort((a, b) => +new Date(a.entryDate) - +new Date(b.entryDate));
    const revenueTotal = rows.reduce((s, r) => s.plus(r.revenue), new Prisma.Decimal(0));
    const cogsTotal = rows.reduce((s, r) => s.plus(r.cogs), new Prisma.Decimal(0));
    return {
      rows,
      totals: {
        revenue: revenueTotal,
        cogs: cogsTotal,
        grossProfit: revenueTotal.minus(cogsTotal),
        marginPct:
          revenueTotal.isZero()
            ? null
            : revenueTotal.minus(cogsTotal).dividedBy(revenueTotal).times(100).toDecimalPlaces(2),
      },
    };
  }
}
