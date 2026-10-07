import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { DailyPriceService } from './daily-price.service';
import {
  CheapestSupplierQueryDto,
  DailyPriceGridQueryDto,
  DailyPriceHistoryQueryDto,
  DailyPriceTodayQueryDto,
  BulkPriceUpdateDto,
  UpsertDailyPriceDto,
} from './pricing.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';
import { SupplierOffersService } from '../price-request/supplier-offers.service';

/**
 * Daily Pricing Engine (Phase 5, REQUIREMENTS §17).
 * - Reads: pricing.view; today upsert: pricing.create; bulk: pricing.edit;
 *   past-day edits additionally need pricing.edit_history (row-level rule).
 * - The cheapest-supplier report reuses the Phase 4 SupplierOffersService
 *   RANK() daily-lowest pattern (no averages anywhere).
 */
@Controller('pricing')
export class PricingController {
  constructor(
    private readonly dailyPriceService: DailyPriceService,
    private readonly offersService: SupplierOffersService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post('daily')
  @RequirePermissions('pricing.create')
  async upsert(
    @Body() dto: UpsertDailyPriceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    return this.dailyPriceService.upsert(companyId, dto, actor, this.ctx(request), {
      allowHistoryEdit: effective.has('pricing.edit_history'),
    });
  }

  @Get('daily')
  @RequirePermissions('pricing.view')
  async grid(@Query() query: DailyPriceGridQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.dailyPriceService.grid(companyId, query);
  }

  @Get('daily/today')
  @RequirePermissions('pricing.view')
  async today(@Query() query: DailyPriceTodayQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.dailyPriceService.getToday(companyId, query.variantId, query.uomId);
  }

  @Get('daily/history')
  @RequirePermissions('pricing.view')
  async history(@Query() query: DailyPriceHistoryQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.dailyPriceService.history(companyId, query.variantId, query.from, query.to);
  }

  @Post('daily/bulk')
  @RequirePermissions('pricing.edit')
  async bulkUpdate(
    @Body() dto: BulkPriceUpdateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.dailyPriceService.bulkUpdate(companyId, dto, actor, this.ctx(request));
  }

  /** "Supplier X was the daily cheapest K times for this variant in N days." */
  @Get('suppliers/cheapest')
  @RequirePermissions('pricing.view')
  async cheapestReport(
    @Query() query: CheapestSupplierQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.offersService.cheapestReport(companyId, query);
  }
}
