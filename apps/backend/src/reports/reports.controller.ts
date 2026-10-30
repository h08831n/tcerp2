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
}
