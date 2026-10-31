import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ForbiddenError, ValidationError } from '../common/errors';
import { dayKeyOf, parseDayKey } from '../pricing/day';

/** Numbers from raw SQL come back as strings (Decimal) — normalize for JSON. */
function n(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * LOCAL midnight of the day key — the dashboard compares against timestamptz
 * business timestamps (loading_date), so the day boundary must be the local
 * calendar day, NOT the pricing module's UTC-midnight normalization (which
 * lags the Iranian afternoon into the previous UTC day).
 */
function dayStart(dateKey: string): Date {
  const day = parseDayKey(dateKey); // validates the YYYY-MM-DD shape
  return new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/**
 * Management reports (Phase 10, Gate F — REQUIREMENTS §31/§33). Every figure
 * is aggregated in SQL over the operational SOURCE OF TRUTH (sales/purchase
 * documents, loadings, stock movements, parties) — never over tax invoices
 * (REQUIREMENTS §35: tax layer is not a profit/ops source) and never over
 * paged subsets (totals are computed over the whole filtered set).
 * Company scoping: every query filters company_id from the resolved context.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────── dashboard summary ─────────────────────

  async dashboard(companyId: string, today?: string) {
    const dateKey = today ?? dayKeyOf(new Date());
    const day = dayStart(dateKey);
    const monthStart = new Date(day.getFullYear(), day.getMonth(), 1);

    const [sales, purchase, loadings, inactiveCustomers, negativeStock] = await Promise.all([
      this.prisma.$queryRaw<Array<{
        open_quotations: bigint;
        open_quotation_total: string;
        open_orders: bigint;
        open_order_total: string;
        completed_month: bigint;
        completed_month_total: string;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('QUOTATION', 'SENT')) AS open_quotations,
          COALESCE(SUM(total) FILTER (WHERE status IN ('QUOTATION', 'SENT')), 0) AS open_quotation_total,
          COUNT(*) FILTER (WHERE status IN ('SALES_ORDER', 'PARTIALLY_LOADED')) AS open_orders,
          COALESCE(SUM(total) FILTER (WHERE status IN ('SALES_ORDER', 'PARTIALLY_LOADED')), 0) AS open_order_total,
          COUNT(*) FILTER (WHERE status = 'COMPLETED' AND document_date >= ${monthStart}) AS completed_month,
          COALESCE(SUM(total) FILTER (WHERE status = 'COMPLETED' AND document_date >= ${monthStart}), 0) AS completed_month_total
        FROM sales_documents
        WHERE company_id = ${companyId}::uuid
          AND status NOT IN ('DRAFT', 'CANCELLED', 'LOST')
      `),
      this.prisma.$queryRaw<Array<{
        open_orders: bigint;
        open_order_total: string;
        completed_month: bigint;
        completed_month_total: string;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE status IN ('ORDER_PLACED', 'PARTIALLY_LOADED')) AS open_orders,
          COALESCE(SUM(total) FILTER (WHERE status IN ('ORDER_PLACED', 'PARTIALLY_LOADED')), 0) AS open_order_total,
          COUNT(*) FILTER (WHERE status = 'COMPLETED' AND document_date >= ${monthStart}) AS completed_month,
          COALESCE(SUM(total) FILTER (WHERE status = 'COMPLETED' AND document_date >= ${monthStart}), 0) AS completed_month_total
        FROM purchase_documents
        WHERE company_id = ${companyId}::uuid
          AND status NOT IN ('DRAFT', 'CANCELLED')
      `),
      this.prisma.$queryRaw<Array<{
        today_count: bigint;
        pending_driver_release: bigint;
        reversed_month: bigint;
      }>>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE loading_date >= ${day}) AS today_count,
          COUNT(*) FILTER (WHERE driver_info_restricted = true AND status = 'CONFIRMED') AS pending_driver_release,
          COUNT(*) FILTER (WHERE status = 'REVERSED' AND loading_date >= ${monthStart}) AS reversed_month
        FROM loadings
        WHERE company_id = ${companyId}::uuid
          AND status <> 'CANCELLED'
      `),
      this.countInactiveCustomers(companyId),
      this.countNegativeStockVariants(companyId),
    ]);

    const s = sales[0];
    const p = purchase[0];
    const l = loadings[0];
    return {
      date: dateKey,
      sales: {
        openQuotations: n(s?.open_quotations),
        openQuotationTotal: n(s?.open_quotation_total),
        openOrders: n(s?.open_orders),
        openOrderTotal: n(s?.open_order_total),
        completedThisMonth: n(s?.completed_month),
        completedThisMonthTotal: n(s?.completed_month_total),
      },
      purchase: {
        openOrders: n(p?.open_orders),
        openOrderTotal: n(p?.open_order_total),
        completedThisMonth: n(p?.completed_month),
        completedThisMonthTotal: n(p?.completed_month_total),
      },
      loadings: {
        todayCount: n(l?.today_count),
        pendingDriverRelease: n(l?.pending_driver_release),
        reversedThisMonth: n(l?.reversed_month),
      },
      customers: {
        inactiveCount: inactiveCustomers,
      },
      inventory: {
        negativeStockVariants: negativeStock,
      },
    };
  }

  // ───────────────────── sales performance ─────────────────────

  async salesPerformance(companyId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      user_id: string;
      username: string;
      open_quotations: bigint;
      open_quotation_total: string;
      open_orders: bigint;
      open_order_total: string;
      completed_count: bigint;
      completed_total: string;
    }>>(Prisma.sql`
      SELECT u.id AS user_id, u.username,
        COUNT(*) FILTER (WHERE sd.status IN ('QUOTATION', 'SENT')) AS open_quotations,
        COALESCE(SUM(sd.total) FILTER (WHERE sd.status IN ('QUOTATION', 'SENT')), 0) AS open_quotation_total,
        COUNT(*) FILTER (WHERE sd.status IN ('SALES_ORDER', 'PARTIALLY_LOADED')) AS open_orders,
        COALESCE(SUM(sd.total) FILTER (WHERE sd.status IN ('SALES_ORDER', 'PARTIALLY_LOADED')), 0) AS open_order_total,
        COUNT(*) FILTER (WHERE sd.status = 'COMPLETED') AS completed_count,
        COALESCE(SUM(sd.total) FILTER (WHERE sd.status = 'COMPLETED'), 0) AS completed_total
      FROM sales_documents sd
      JOIN users u ON u.id = sd.salesperson_user_id
      WHERE sd.company_id = ${companyId}::uuid
        AND sd.status NOT IN ('DRAFT', 'CANCELLED', 'LOST')
      GROUP BY u.id, u.username
      ORDER BY completed_total DESC
    `);

    // Delivered quantity per salesperson: CONFIRMED loading allocations
    // mapped back through the sales lines to the document's owner.
    const delivered = await this.prisma.$queryRaw<Array<{ user_id: string; delivered_qty: string }>>(
      Prisma.sql`
        SELECT sd.salesperson_user_id AS user_id, COALESCE(SUM(la.allocated_quantity), 0) AS delivered_qty
        FROM loading_allocations la
        JOIN loading_lines ll ON ll.id = la.loading_line_id
        JOIN loadings lg ON lg.id = ll.loading_id AND lg.status = 'CONFIRMED'
        JOIN sales_lines sl ON sl.id = la.sales_line_id
        JOIN sales_documents sd ON sd.id = sl.sales_document_id
        WHERE la.sales_line_id IS NOT NULL
          AND sd.company_id = ${companyId}::uuid
        GROUP BY sd.salesperson_user_id
      `,
    );
    const deliveredBy = new Map(delivered.map((d) => [d.user_id, n(d.delivered_qty)]));

    return rows.map((r) => ({
      userId: r.user_id,
      username: r.username,
      openQuotations: n(r.open_quotations),
      openQuotationTotal: n(r.open_quotation_total),
      openOrders: n(r.open_orders),
      openOrderTotal: n(r.open_order_total),
      completedCount: n(r.completed_count),
      completedTotal: n(r.completed_total),
      deliveredQty: deliveredBy.get(r.user_id) ?? 0,
    }));
  }

  // ───────────────────── purchase performance ─────────────────────

  async purchasePerformance(companyId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      party_id: string;
      name_fa: string;
      orders_count: bigint;
      ordered_total: string;
      open_total: string;
      completed_total: string;
    }>>(Prisma.sql`
      SELECT p.id AS party_id, p.name_fa,
        COUNT(*) AS orders_count,
        COALESCE(SUM(pd.total), 0) AS ordered_total,
        COALESCE(SUM(pd.total) FILTER (WHERE pd.status IN ('ORDER_PLACED', 'PARTIALLY_LOADED')), 0) AS open_total,
        COALESCE(SUM(pd.total) FILTER (WHERE pd.status = 'COMPLETED'), 0) AS completed_total
      FROM purchase_documents pd
      JOIN parties p ON p.id = pd.supplier_party_id
      WHERE pd.company_id = ${companyId}::uuid
        AND pd.status NOT IN ('DRAFT', 'CANCELLED')
      GROUP BY p.id, p.name_fa
      ORDER BY ordered_total DESC
    `);

    const received = await this.prisma.$queryRaw<Array<{ party_id: string; received_qty: string }>>(
      Prisma.sql`
        SELECT pd.supplier_party_id AS party_id, COALESCE(SUM(grl.actual_quantity), 0) AS received_qty
        FROM goods_receipt_lines grl
        JOIN goods_receipts gr ON gr.id = grl.goods_receipt_id AND gr.status = 'CONFIRMED'
        JOIN purchase_lines pl ON pl.id = grl.purchase_line_id
        JOIN purchase_documents pd ON pd.id = pl.purchase_document_id
        WHERE pd.company_id = ${companyId}::uuid
        GROUP BY pd.supplier_party_id
      `,
    );
    const receivedBy = new Map(received.map((r) => [r.party_id, n(r.received_qty)]));

    return rows.map((r) => ({
      partyId: r.party_id,
      supplierName: r.name_fa,
      ordersCount: n(r.orders_count),
      orderedTotal: n(r.ordered_total),
      openTotal: n(r.open_total),
      completedTotal: n(r.completed_total),
      receivedQty: receivedBy.get(r.party_id) ?? 0,
    }));
  }

  // ───────────────────── inactive customers ─────────────────────

  /** COUNT for the dashboard card (no row materialization). */
  private async countInactiveCustomers(companyId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS count
      FROM parties p
      JOIN party_roles pr ON pr.party_id = p.id AND pr.role = 'CUSTOMER'
      WHERE p.company_id = ${companyId}::uuid
        AND p.archived_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM sales_documents sd
          WHERE sd.customer_party_id = p.id AND sd.status <> 'CANCELLED'
            AND sd.document_date >= NOW() - INTERVAL '60 days'
        )
    `);
    return n(rows[0]?.count);
  }

  /** 60-day inactivity window (REQUIREMENTS: مشتریان غیرفعال). */
  async inactiveCustomers(companyId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      name_fa: string;
      owner_user_id: string | null;
      last_purchase: Date | null;
      days_since: number | null;
      has_mobile: boolean;
    }>>(Prisma.sql`
      SELECT p.id, p.name_fa, p.owner_user_id,
        MAX(sd.document_date) AS last_purchase,
        CASE WHEN MAX(sd.document_date) IS NULL THEN NULL
          ELSE FLOOR(EXTRACT(EPOCH FROM (NOW() - MAX(sd.document_date))) / 86400)::int END AS days_since,
        EXISTS (SELECT 1 FROM party_phones pp WHERE pp.party_id = p.id AND pp.kind = 'MOBILE') AS has_mobile
      FROM parties p
      JOIN party_roles pr ON pr.party_id = p.id AND pr.role = 'CUSTOMER'
      LEFT JOIN sales_documents sd ON sd.customer_party_id = p.id AND sd.status <> 'CANCELLED'
      WHERE p.company_id = ${companyId}::uuid
        AND p.archived_at IS NULL
      GROUP BY p.id, p.name_fa, p.owner_user_id
      HAVING MAX(sd.document_date) IS NULL OR MAX(sd.document_date) < NOW() - INTERVAL '60 days'
      ORDER BY last_purchase NULLS FIRST
      LIMIT 200
    `);
    return rows.map((r) => ({
      partyId: r.id,
      nameFa: r.name_fa,
      ownerUserId: r.owner_user_id,
      lastPurchaseDate: r.last_purchase ? r.last_purchase.toISOString().slice(0, 10) : null,
      daysSinceLastPurchase: r.days_since,
      hasMobile: r.has_mobile,
    }));
  }

  // ───────────────────── pending sales orders ─────────────────────

  async pendingOrders(companyId: string, olderThanDays = 7) {
    const days = Math.floor(Number(olderThanDays));
    if (!Number.isFinite(days) || days < 0 || days > 365) {
      throw new ValidationError('REPORT_INVALID_DAYS', { olderThanDays });
    }
    const rows = await this.prisma.$queryRaw<Array<{
      id: string;
      document_number: string;
      status: string;
      document_date: Date;
      total: string;
      customer_name: string;
      salesperson: string;
      age_days: number;
    }>>(Prisma.sql`
      SELECT sd.id, sd.document_number, sd.status, sd.document_date, sd.total,
        c.name_fa AS customer_name, u.username AS salesperson,
        FLOOR(EXTRACT(EPOCH FROM (NOW() - sd.document_date)) / 86400)::int AS age_days
      FROM sales_documents sd
      JOIN parties c ON c.id = sd.customer_party_id
      JOIN users u ON u.id = sd.salesperson_user_id
      WHERE sd.company_id = ${companyId}::uuid
        AND sd.status IN ('SALES_ORDER', 'PARTIALLY_LOADED')
        AND sd.document_date < NOW() - ${days} * INTERVAL '1 day'
      ORDER BY sd.document_date ASC
    `);
    return {
      total: rows.length,
      totalAmount: rows.reduce((sum, r) => sum + n(r.total), 0),
      items: rows.slice(0, 50).map((r) => ({
        documentId: r.id,
        documentNumber: r.document_number,
        status: r.status,
        documentDate: r.document_date,
        total: n(r.total),
        customerName: r.customer_name,
        salesperson: r.salesperson,
        ageDays: n(r.age_days),
      })),
    };
  }

  // ───────────────────── negative stock ─────────────────────

  /** COUNT for the dashboard card. */
  private async countNegativeStockVariants(companyId: string): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*) AS count FROM (
        SELECT sm.product_variant_id,
          SUM(CASE
            WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
            WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
            ELSE 0 END) AS balance
        FROM stock_movements sm
        JOIN stock_locations dl ON dl.id = sm.destination_location_id
        JOIN stock_locations sl ON sl.id = sm.source_location_id
        WHERE sm.company_id = ${companyId}::uuid
        GROUP BY sm.product_variant_id
        HAVING SUM(CASE
            WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
            WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
            ELSE 0 END) < 0
      ) negative
    `);
    return n(rows[0]?.count);
  }

  /** Per-variant INTERNAL balance (the inventory module's source of truth). */
  async negativeStock(companyId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      variant_id: string;
      sku: string;
      variant_name: string;
      balance: string;
    }>>(Prisma.sql`
      SELECT sm.product_variant_id AS variant_id, pv.sku,
        COALESCE(pv.name_fa, pv.name_en, pv.sku) AS variant_name,
        SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
          ELSE 0 END) AS balance
      FROM stock_movements sm
      JOIN stock_locations dl ON dl.id = sm.destination_location_id
      JOIN stock_locations sl ON sl.id = sm.source_location_id
      JOIN product_variants pv ON pv.id = sm.product_variant_id
      WHERE sm.company_id = ${companyId}::uuid
      GROUP BY sm.product_variant_id, pv.sku, pv.name_fa, pv.name_en
      HAVING SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
          ELSE 0 END) < 0
      ORDER BY balance ASC
      LIMIT 100
    `);
    return rows.map((r) => ({
      variantId: r.variant_id,
      sku: r.sku,
      variantName: r.variant_name,
      balance: n(r.balance),
    }));
  }

  // ───────────────────── debt report (Gate F slice 2) ─────────────────────

  /**
   * گزارش بدهی (REQUIREMENTS §20/§33): per-party accounting balance (from the
   * 7C subsidiary ledger — POSTED/REVERSED journals only), the cached
   * OPERATIONAL balance, their reconciliation delta, the party's UNMATCHED
   * settlement claims (declared-but-unreconciled) and UNSETTLED checks
   * (REGISTERED/PENDING/DEPOSITED/BOUNCED — cleared/paid/cancelled are
   * settled facts). Gated by accounting.report (financial visibility).
   */
  async debtReport(companyId: string, role: 'CUSTOMER' | 'SUPPLIER', search?: string) {
    const accountCode = role === 'SUPPLIER' ? 'PAYABLE' : 'RECEIVABLE';
    const sign = role === 'SUPPLIER' ? -1 : 1;
    // LEFT-JOIN semantics (deliberately NOT the subsidiary ledger's INNER
    // join): a party holding an operational balance but NO journal history is
    // exactly a reconciliation gap and must appear with accounting = 0. The
    // balance formula mirrors the 7C subsidiary ledger (debit − credit, signed
    // per role; POSTED/REVERSED entries only) — g7c pins that math.
    const balances = await this.prisma.$queryRaw<Array<{
      party_id: string;
      name_fa: string;
      accounting_balance: string;
      last_activity: Date | null;
    }>>(Prisma.sql`
      SELECT p.id AS party_id, p.name_fa,
        (COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0)) * ${sign} AS accounting_balance,
        MAX(je.entry_date) AS last_activity
      FROM parties p
      JOIN party_roles pr ON pr.party_id = p.id AND pr.role = ${role}::"PartyRoleType"
      LEFT JOIN journal_lines l ON l.party_id = p.id
      LEFT JOIN journal_entries je ON je.id = l.journal_entry_id
        AND je.company_id = ${companyId}::uuid AND je.status IN ('POSTED', 'REVERSED')
      LEFT JOIN chart_of_accounts a ON a.id = l.account_id AND a.code = ${accountCode}
      WHERE p.company_id = ${companyId}::uuid AND p.archived_at IS NULL
        ${search ? Prisma.sql`AND p.name_fa ILIKE ${'%' + search + '%'}` : Prisma.empty}
      GROUP BY p.id, p.name_fa
      HAVING COALESCE(SUM(l.debit), 0) <> COALESCE(SUM(l.credit), 0)
        OR EXISTS (SELECT 1 FROM party_operational_balances b WHERE b.party_id = p.id AND b.balance <> 0)
        OR EXISTS (SELECT 1 FROM operational_settlement_claims c WHERE c.party_id = p.id AND c.status = 'UNMATCHED')
        OR EXISTS (SELECT 1 FROM checks k WHERE k.party_id = p.id AND k.status IN ('REGISTERED', 'PENDING', 'DEPOSITED', 'BOUNCED'))
      ORDER BY accounting_balance DESC
      LIMIT 200
    `);
    const claimDirection = role === 'SUPPLIER' ? 'SUPPLIER_PAYMENT' : 'CUSTOMER_RECEIPT';
    const [claims, checks] = await Promise.all([
      this.prisma.$queryRaw<Array<{ party_id: string; count: bigint; total: string }>>(Prisma.sql`
        SELECT c.party_id, COUNT(*) AS count, COALESCE(SUM(c.amount), 0) AS total
        FROM operational_settlement_claims c
        WHERE c.company_id = ${companyId}::uuid
          AND c.status = 'UNMATCHED'
          AND c.direction = ${claimDirection}::"ClaimDirection"
        GROUP BY c.party_id
      `),
      this.prisma.$queryRaw<Array<{ party_id: string; count: bigint; total: string; nearest_due: Date | null }>>(Prisma.sql`
        SELECT k.party_id, COUNT(*) AS count, COALESCE(SUM(k.amount), 0) AS total, MIN(k.due_date) AS nearest_due
        FROM checks k
        WHERE k.company_id = ${companyId}::uuid
          AND k.party_id IS NOT NULL
          AND k.status IN ('REGISTERED', 'PENDING', 'DEPOSITED', 'BOUNCED')
        GROUP BY k.party_id
      `),
    ]);
    const partyIds = balances.map((b) => b.party_id);
    const [claimsBy, checksBy, opBalances] = await Promise.all([
      Promise.resolve(new Map(claims.map((c) => [c.party_id, c]))),
      Promise.resolve(new Map(checks.map((c) => [c.party_id, c]))),
      partyIds.length
        ? this.prisma.partyOperationalBalance.findMany({
            where: { companyId, partyId: { in: partyIds } },
            select: { partyId: true, balance: true },
          })
        : Promise.resolve([] as Array<{ partyId: string; balance: Prisma.Decimal }>),
    ]);
    const opBy = new Map(opBalances.map((b) => [b.partyId, b.balance]));

    const items = balances.map((item) => {
      const claim = claimsBy.get(item.party_id);
      const check = checksBy.get(item.party_id);
      const accountingBalance = n(item.accounting_balance);
      const op = opBy.get(item.party_id);
      const operationalBalance = op === undefined ? null : Number(op);
      const reconciliationDelta =
        op === undefined ? null : accountingBalance - Number(op);
      return {
        partyId: item.party_id,
        nameFa: item.name_fa,
        accountingBalance,
        operationalBalance,
        reconciliationDelta,
        unmatchedClaims: claim
          ? { count: n(claim.count), total: n(claim.total) }
          : { count: 0, total: 0 },
        unsettledChecks: check
          ? { count: n(check.count), total: n(check.total), nearestDueDate: check.nearest_due }
          : { count: 0, total: 0, nearestDueDate: null },
        lastActivity: item.last_activity,
      };
    });
    return {
      role,
      accountCode,
      groupTotal: items.reduce((sum, i) => sum + i.accountingBalance, 0),
      items,
    };
  }

  // ───────────────────── offers win/loss (Gate F slice 2) ─────────────────────

  /**
   * برد/باخت پیشنهادها — aggregates the EXPLICIT decisions only
   * (SupplierOffer.outcome). Suppliers without any decided offer are absent:
   * the report never guesses (handover rule).
   */
  async offersOutcomeReport(companyId: string) {
    const perSupplier = await this.prisma.$queryRaw<Array<{
      party_id: string;
      name_fa: string;
      offers_count: bigint;
      won: bigint;
      lost: bigint;
      avg_offered: string | null;
    }>>(Prisma.sql`
      SELECT o.supplier_party_id AS party_id, p.name_fa,
        COUNT(*) AS offers_count,
        COUNT(*) FILTER (WHERE o.outcome = 'WON') AS won,
        COUNT(*) FILTER (WHERE o.outcome = 'LOST') AS lost,
        AVG(o.offered_price) AS avg_offered
      FROM supplier_offers o
      JOIN parties p ON p.id = o.supplier_party_id
      WHERE o.company_id = ${companyId}::uuid
        AND o.outcome IS NOT NULL
      GROUP BY o.supplier_party_id, p.name_fa
      ORDER BY won DESC, offers_count DESC
    `);
    const recent = await this.prisma.supplierOffer.findMany({
      where: { companyId, outcome: { not: null } },
      orderBy: { outcomeDecidedAt: 'desc' },
      take: 50,
      select: {
        id: true,
        offeredPrice: true,
        outcome: true,
        outcomeDecidedAt: true,
        supplier: { select: { id: true, nameFa: true } },
        priceRequestLine: {
          select: {
            id: true,
            priceRequest: { select: { id: true, requestNumber: true } },
          },
        },
      },
    });
    return {
      perSupplier: perSupplier.map((r) => {
        const won = n(r.won);
        const decided = won + n(r.lost);
        return {
          partyId: r.party_id,
          supplierName: r.name_fa,
          offersCount: n(r.offers_count),
          won,
          lost: n(r.lost),
          winRate: decided > 0 ? Math.round((won / decided) * 100) : 0,
          avgOfferedPrice: r.avg_offered === null ? null : n(r.avg_offered),
        };
      }),
      recent: recent.map((o) => ({
        offerId: o.id,
        supplierName: o.supplier.nameFa,
        offeredPrice: n(o.offeredPrice),
        outcome: o.outcome,
        decidedAt: o.outcomeDecidedAt,
        requestId: o.priceRequestLine.priceRequest.id,
        requestNumber: o.priceRequestLine.priceRequest.requestNumber,
      })),
    };
  }

  // ───────────────────── per-warehouse negative stock + turnover ─────────────

  /**
   * موجودی منفی به تفکیک انبار: movement quantities attribute to the
   * warehouse of the INTERNAL side (destination for IN, source for OUT);
   * internal→internal transfers attribute to BOTH sides and net out within
   * the same warehouse.
   */
  async negativeStockByWarehouse(companyId: string) {
    const rows = await this.prisma.$queryRaw<Array<{
      warehouse_id: string | null;
      warehouse_name: string | null;
      variant_id: string;
      sku: string;
      variant_name: string;
      balance: string;
    }>>(Prisma.sql`
      SELECT w.id AS warehouse_id, w.name_fa AS warehouse_name,
        sm.product_variant_id AS variant_id, pv.sku,
        COALESCE(pv.name_fa, pv.name_en, pv.sku) AS variant_name,
        SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
          ELSE 0 END) AS balance
      FROM stock_movements sm
      JOIN stock_locations dl ON dl.id = sm.destination_location_id
      JOIN stock_locations sl ON sl.id = sm.source_location_id
      JOIN product_variants pv ON pv.id = sm.product_variant_id
      LEFT JOIN warehouses w ON w.id = COALESCE(
        CASE WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN dl.warehouse_id END,
        CASE WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN sl.warehouse_id END,
        CASE WHEN dl.type = 'INTERNAL' AND sl.type = 'INTERNAL' THEN dl.warehouse_id END
      )
      WHERE sm.company_id = ${companyId}::uuid
      GROUP BY w.id, w.name_fa, sm.product_variant_id, pv.sku, pv.name_fa, pv.name_en
      HAVING SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
          ELSE 0 END) < 0
      ORDER BY balance ASC
      LIMIT 200
    `);
    return rows.map((r) => ({
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name,
      variantId: r.variant_id,
      sku: r.sku,
      variantName: r.variant_name,
      balance: n(r.balance),
    }));
  }

  /** گردش انبار: period IN/OUT per (warehouse, variant) + full-history ending balance. */
  async warehouseTurnover(companyId: string, fromDate: Date, toDate: Date) {
    if (!(fromDate.getTime() <= toDate.getTime())) {
      throw new ValidationError('REPORT_INVALID_PERIOD', { fromDate, toDate });
    }
    const rows = await this.prisma.$queryRaw<Array<{
      warehouse_id: string | null;
      warehouse_name: string | null;
      variant_id: string;
      sku: string;
      variant_name: string;
      in_qty: string;
      out_qty: string;
      ending_balance: string;
    }>>(Prisma.sql`
      SELECT w.id AS warehouse_id, w.name_fa AS warehouse_name,
        sm.product_variant_id AS variant_id, pv.sku,
        COALESCE(pv.name_fa, pv.name_en, pv.sku) AS variant_name,
        COALESCE(SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' AND sm.movement_date >= ${fromDate} AND sm.movement_date <= ${toDate}
          THEN sm.normalized_quantity ELSE 0 END), 0) AS in_qty,
        COALESCE(SUM(CASE
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' AND sm.movement_date >= ${fromDate} AND sm.movement_date <= ${toDate}
          THEN sm.normalized_quantity ELSE 0 END), 0) AS out_qty,
        SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN sm.normalized_quantity
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN -sm.normalized_quantity
          ELSE 0 END) AS ending_balance
      FROM stock_movements sm
      JOIN stock_locations dl ON dl.id = sm.destination_location_id
      JOIN stock_locations sl ON sl.id = sm.source_location_id
      JOIN product_variants pv ON pv.id = sm.product_variant_id
      LEFT JOIN warehouses w ON w.id = COALESCE(
        CASE WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' THEN dl.warehouse_id END,
        CASE WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' THEN sl.warehouse_id END,
        CASE WHEN dl.type = 'INTERNAL' AND sl.type = 'INTERNAL' THEN dl.warehouse_id END
      )
      WHERE sm.company_id = ${companyId}::uuid
      GROUP BY w.id, w.name_fa, sm.product_variant_id, pv.sku, pv.name_fa, pv.name_en
      HAVING COALESCE(SUM(CASE
          WHEN dl.type = 'INTERNAL' AND sl.type <> 'INTERNAL' AND sm.movement_date >= ${fromDate} AND sm.movement_date <= ${toDate}
          THEN sm.normalized_quantity ELSE 0 END), 0) > 0
          OR COALESCE(SUM(CASE
          WHEN sl.type = 'INTERNAL' AND dl.type <> 'INTERNAL' AND sm.movement_date >= ${fromDate} AND sm.movement_date <= ${toDate}
          THEN sm.normalized_quantity ELSE 0 END), 0) > 0
      ORDER BY in_qty DESC
      LIMIT 200
    `);
    return rows.map((r) => ({
      warehouseId: r.warehouse_id,
      warehouseName: r.warehouse_name,
      variantId: r.variant_id,
      sku: r.sku,
      variantName: r.variant_name,
      inQty: n(r.in_qty),
      outQty: n(r.out_qty),
      endingBalance: n(r.ending_balance),
    }));
  }

  // ───────────────────── global search ─────────────────────

  /**
   * سراسری — LIMIT 5 per entity type, company-scoped. Feeds the Ctrl+K
   * command palette. Fragments are parameterized (never interpolated).
   */
  async globalSearch(companyId: string, term: string) {
    const q = String(term ?? '').trim();
    if (q.length < 2) {
      throw new ValidationError('REPORT_SEARCH_TERM_TOO_SHORT', { minLength: 2 });
    }
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;

    const [parties, variants, salesDocs, purchaseDocs] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name_fa: string; type: string }>>(Prisma.sql`
        SELECT p.id, p.name_fa, p.type FROM parties p
        WHERE p.company_id = ${companyId}::uuid AND p.archived_at IS NULL
          AND (p.name_fa ILIKE ${like} OR p.name_en ILIKE ${like}
               OR EXISTS (SELECT 1 FROM party_phones pp WHERE pp.party_id = p.id AND pp.normalized_value ILIKE ${like}))
        ORDER BY p.name_fa LIMIT 5
      `),
      this.prisma.$queryRaw<Array<{ id: string; sku: string; name: string }>>(Prisma.sql`
        SELECT pv.id, pv.sku, COALESCE(pv.name_fa, pv.name_en, pv.sku) AS name FROM product_variants pv
        JOIN product_templates pt ON pt.id = pv.template_id
        WHERE pt.company_id = ${companyId}::uuid
          AND (pv.sku ILIKE ${like} OR pv.name_fa ILIKE ${like} OR pv.name_en ILIKE ${like})
        ORDER BY pv.sku LIMIT 5
      `),
      this.prisma.$queryRaw<Array<{ id: string; document_number: string; status: string; total: string }>>(Prisma.sql`
        SELECT sd.id, sd.document_number, sd.status, sd.total FROM sales_documents sd
        WHERE sd.company_id = ${companyId}::uuid AND sd.document_number ILIKE ${like}
        ORDER BY sd.document_date DESC LIMIT 5
      `),
      this.prisma.$queryRaw<Array<{ id: string; document_number: string; status: string; total: string }>>(Prisma.sql`
        SELECT pd.id, pd.document_number, pd.status, pd.total FROM purchase_documents pd
        WHERE pd.company_id = ${companyId}::uuid AND pd.document_number ILIKE ${like}
        ORDER BY pd.document_date DESC LIMIT 5
      `),
    ]);

    return {
      parties: parties.map((r) => ({ id: r.id, label: r.name_fa, type: r.type })),
      variants: variants.map((r) => ({ id: r.id, label: `${r.name} (${r.sku})` })),
      salesDocuments: salesDocs.map((r) => ({
        id: r.id,
        label: r.document_number,
        status: r.status,
        total: n(r.total),
      })),
      purchaseDocuments: purchaseDocs.map((r) => ({
        id: r.id,
        label: r.document_number,
        status: r.status,
        total: n(r.total),
      })),
    };
  }

  /** Guard for the report endpoints: the company context must be resolved. */
  assertCompanyScope(companyId: string | null): string {
    if (!companyId) {
      throw new ForbiddenError('REPORT_COMPANY_CONTEXT_REQUIRED');
    }
    return companyId;
  }

  /** Placeholder guard used by controllers resolving optional day filters. */
  parseOptionalDay(dateKey: string | undefined): string | undefined {
    if (!dateKey) return undefined;
    parseDayKey(dateKey);
    return dateKey;
  }

}
