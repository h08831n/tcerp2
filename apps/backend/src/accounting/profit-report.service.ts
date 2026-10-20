import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Operational profit (docs/06 section 4, integrity gates #4/#5/#6):
 * derived EXCLUSIVELY from AccountingEvent snapshot rows (which reference the
 * posted operational journals). NEVER queries sales/purchase/loading tables
 * for financial values or dimensions — those are captured at event time as
 * immutable snapshots (customerId, salespersonUserId, productVariantId,
 * supplierId + measures REVENUE/COGS). Operational document ids are carried
 * for user navigation links only.
 */
@Injectable()
export class ProfitReportService {
  constructor(private readonly prisma: PrismaService) {}

  async operationalProfit(
    companyId: string,
    opts: { from?: Date; to?: Date; customerId?: string; salespersonUserId?: string; productVariantId?: string; supplierId?: string },
  ) {
    // Date basis (P2, ratified): FINANCIAL date = JournalEntry.entryDate
    // (the operational loading date captured at event time), NOT the event
    // bookkeeping timestamp createdAt. The journal entry is the source of
    // truth; the event row is only its dimensional index.
    // AccountingEvent has no journalEntry relation (journalEntryId only).
    // Fetch events, then resolve entry dates via a separate journalEntry query.
    const eventRows = await this.prisma.accountingEvent.findMany({
      where: {
        companyId,
        eventType: { in: ['SALES_COMPLETED_LOADING', 'INVENTORY_REVERSAL'] as const },
        status: 'POSTED',
      },
      orderBy: { createdAt: 'asc' as const },
      select: {
        id: true,
        eventType: true,
        sourceEntityType: true,
        sourceEntityId: true,
        payload: true,
        journalEntryId: true,
        createdAt: true,
      },
    });
    const journalEntries = await this.prisma.journalEntry.findMany({
      where: {
        companyId,
        status: { in: ['POSTED', 'REVERSED'] as ('POSTED' | 'REVERSED')[] },
        id: { in: eventRows.map((e) => e.journalEntryId).filter((id): id is string => !!id) },
        ...(opts.from || opts.to
          ? { entryDate: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
          : {}),
      },
      select: { id: true, entryDate: true },
    });
    const entryDateById = new Map(journalEntries.map((j) => [j.id, j.entryDate]));
    const events = eventRows.filter(
      (e): e is typeof e & { journalEntryId: string } =>
        typeof e.journalEntryId === 'string' && entryDateById.has(e.journalEntryId),
    );

    // Reversal events negate: both the INVENTORY_REVERSAL type AND
    // SALES_COMPLETED_LOADING events emitted by loading reversals with
    // payload.reversal = true (side-swapped journal). Without the payload
    // check a loading reversal would double-count revenue/cogs.
    const sign = (e: (typeof events)[number]) =>
      e.eventType === 'INVENTORY_REVERSAL' ||
      (e.payload as { reversal?: boolean } | null)?.reversal === true
        ? -1
        : 1;
    const rows = [];
    for (const e of events) {
      const payload = e.payload as {
        measures?: Record<string, string | number>;
        analytics?: { customerId?: string; supplierId?: string; salespersonUserId?: string; productVariantId?: string };
      } | null;
      const measures = payload?.measures ?? {};
      const analytics = payload?.analytics ?? {};
      const revenue = new Prisma.Decimal(measures.REVENUE ?? 0).times(sign(e));
      const cogs = new Prisma.Decimal(measures.COGS ?? 0).times(sign(e));
      const customerId = analytics.customerId ?? null;
      const variantId = analytics.productVariantId ?? null;
      const salespersonUserId = analytics.salespersonUserId ?? null;
      const supplierId = analytics.supplierId ?? null;
      if (opts.customerId && customerId !== opts.customerId) continue;
      if (opts.salespersonUserId && salespersonUserId !== opts.salespersonUserId) continue;
      if (opts.productVariantId && variantId !== opts.productVariantId) continue;
      if (opts.supplierId && supplierId !== opts.supplierId) continue;

      // navigation-only: party/variant names resolved for display; financial
      // values never come from these reads. Analytics dimension ids may carry
      // non-UUID labels (legacy imports) — only resolve rows that are UUIDs.
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      let customerName: string | null = null;
      if (customerId && UUID_RE.test(customerId)) {
        const party = await this.prisma.party.findUnique({ where: { id: customerId }, select: { nameFa: true } });
        customerName = party?.nameFa ?? null;
      }
      let variantNameFa: string | null = null;
      if (variantId && UUID_RE.test(variantId)) {
        const variant = await this.prisma.productVariant.findUnique({
          where: { id: variantId },
          select: { nameFa: true },
        });
        variantNameFa = variant?.nameFa ?? null;
      }
      rows.push({
        eventId: e.id,
        journalEntryId: e.journalEntryId,
        sourceEntityType: e.sourceEntityType,
        sourceDocumentId: e.sourceEntityId, // navigation link only
        entryDate: entryDateById.get(e.journalEntryId)!,
        eventType: e.eventType,
        customerId,
        customerName,
        salespersonUserId,
        productVariantId: variantId,
        variantNameFa,
        supplierId,
        revenue,
        cogs,
        grossProfit: revenue.minus(cogs),
        marginPct: revenue.isZero() ? null : revenue.minus(cogs).dividedBy(revenue).times(100).toDecimalPlaces(2),
      });
    }

    const revenueTotal = rows.reduce((s, r) => s.plus(r.revenue), new Prisma.Decimal(0));
    const cogsTotal = rows.reduce((s, r) => s.plus(r.cogs), new Prisma.Decimal(0));
    return {
      rows,
      totals: {
        revenue: revenueTotal,
        cogs: cogsTotal,
        grossProfit: revenueTotal.minus(cogsTotal),
        marginPct:
          revenueTotal.isZero() ? null : revenueTotal.minus(cogsTotal).dividedBy(revenueTotal).times(100).toDecimalPlaces(2),
      },
    };
  }
}
