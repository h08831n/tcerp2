import { Controller, Get, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ReportsService } from './reports.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Management report endpoints (Phase 10, Gate F). All read-only, gated by
 * `reports.view` (seeded to admin/sales_manager/purchase_manager/accountant/
 * financial_manager); every figure is company-scoped server-side via the
 * resolved company context.
 */
@Controller('reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get('dashboard')
  @RequirePermissions('reports.view')
  async dashboard(
    @Query('date') date: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.dashboard(companyId, this.reports.parseOptionalDay(date));
  }

  @Get('sales-performance')
  @RequirePermissions('reports.view')
  async salesPerformance(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.salesPerformance(companyId);
  }

  @Get('purchase-performance')
  @RequirePermissions('reports.view')
  async purchasePerformance(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.purchasePerformance(companyId);
  }

  @Get('inactive-customers')
  @RequirePermissions('reports.view')
  async inactiveCustomers(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.inactiveCustomers(companyId);
  }

  @Get('pending-orders')
  @RequirePermissions('reports.view')
  async pendingOrders(
    @Query('olderThanDays') olderThanDays: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.pendingOrders(companyId, olderThanDays ? Number(olderThanDays) : 7);
  }

  @Get('negative-stock')
  @RequirePermissions('reports.view')
  async negativeStock(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.negativeStock(companyId);
  }

  /** سراسری — Ctrl+K palette backend. */
  @Get('search')
  @RequirePermissions('reports.view')
  async search(
    @Query('q') q: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.globalSearch(companyId, q ?? '');
  }

  // ───────────── Gate F slice 2 ─────────────

  /**
   * گزارش بدهی: مانده حسابداری/عملیاتی/اختلاف + تسویه‌های UNMATCHED + چک‌های
   * وصول‌نشده به تفکیک طرف‌حساب. EXPOSES ACCOUNTING BALANCES — gated by
   * `accounting.report` (the same gate as the 7C subsidiary ledger), NOT the
   * general reports.view.
   */
  @Get('debt')
  @RequirePermissions('accounting.report')
  async debt(
    @Query('role') role: string | undefined,
    @Query('search') search: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.reports.debtReport(
      companyId,
      role === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER',
      search || undefined,
    );
  }

  /** برد/باخت پیشنهادها — explicit decisions only (never inferred). */
  @Get('offers-outcome')
  @RequirePermissions('reports.view')
  async offersOutcome(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.offersOutcomeReport(companyId);
  }

  @Get('negative-stock/by-warehouse')
  @RequirePermissions('reports.view')
  async negativeStockByWarehouse(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    return this.reports.negativeStockByWarehouse(companyId);
  }

  @Get('warehouse-turnover')
  @RequirePermissions('reports.view')
  async warehouseTurnover(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = this.reports.assertCompanyScope(
      await this.companyContext.resolveCompanyId(user, request.headers),
    );
    // Local-calendar boundaries (same convention as the dashboard «today»):
    // from = local midnight, to = local end-of-day so the TO day's afternoon
    // movements are inside the window.
    this.reports.parseOptionalDay(from);
    this.reports.parseOptionalDay(to);
    const fromDate = from ? new Date(`${from}T00:00:00`) : new Date(Date.now() - 30 * 86_400_000);
    const toDate = to ? new Date(`${to}T23:59:59.999`) : new Date();
    return this.reports.warehouseTurnover(companyId, fromDate, toDate);
  }
}
