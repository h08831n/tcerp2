import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PriceRequestsService } from './price-requests.service';
import { SupplierOffersService } from './supplier-offers.service';
import {
  AddOfferDto,
  AddPriceRequestLineDto,
  CreatePurchaseFromRequestDto,
  CreatePriceRequestDto,
  CreateSaleFromRequestDto,
  DailyLowestQueryDto,
  LowestReportQueryDto,
  PriceRequestQueryDto,
  UpdateOfferDto,
  UpdatePriceRequestDto,
  UpdatePriceRequestLineDto,
  WorklistQueryDto,
} from './price-request.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Price requests + supplier offers (Phase 4, REQUIREMENTS §14-16).
 * - Reads/creates: price_request.view / price_request.create.
 * - Offers (manage_offers) + worklist intelligence: price_request.manage_offers.
 * - create-sale needs sales.create, create-purchase needs purchase.create
 *   (the underlying document modules enforce their own validations).
 */

@Controller('price-requests')
export class PriceRequestsController {
  constructor(
    private readonly priceRequestsService: PriceRequestsService,
    private readonly offersService: SupplierOffersService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  private async companyIdOf(user: { id: string }, request: Request): Promise<string> {
    return this.companyContext.requireCompanyId(user, request.headers);
  }

  @Post()
  @RequirePermissions('price_request.create')
  async create(
    @Body() dto: CreatePriceRequestDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('price_request.view')
  async list(@Query() query: PriceRequestQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.priceRequestsService.list(companyId, query);
  }

  /** Worklist: today + previous-day (SAME records, never copied). */
  @Get('worklist')
  @RequirePermissions('price_request.view')
  async worklist(@Query() query: WorklistQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.priceRequestsService.worklist(companyId, query.date);
  }

  /** Daily-lowest supplier per (variant, uom) for a day (ties included). */
  @Get('daily-lowest')
  @RequirePermissions('price_request.view')
  async dailyLowest(@Query() query: DailyLowestQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.offersService.getDailyLowest(companyId, query);
  }

  /** "Supplier X: in last N days was daily lowest K times." */
  @Get('suppliers/lowest-report')
  @RequirePermissions('price_request.view')
  async lowestReport(@Query() query: LowestReportQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.offersService.supplierLowestReport(companyId, query.days);
  }

  @Get(':id')
  @RequirePermissions('price_request.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.priceRequestsService.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('price_request.create')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePriceRequestDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Post(':id/lines')
  @RequirePermissions('price_request.create')
  async addLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPriceRequestLineDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.addLine(companyId, id, dto, actor, this.ctx(request));
  }

  @Patch(':id/lines/:lineId')
  @RequirePermissions('price_request.create')
  async updateLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdatePriceRequestLineDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.updateLine(companyId, id, lineId, dto, actor, this.ctx(request));
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions('price_request.create')
  async deleteLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.deleteLine(companyId, id, lineId, actor, this.ctx(request));
  }

  @Post(':id/convert')
  @RequirePermissions('price_request.create')
  async convert(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.convert(companyId, id, actor, this.ctx(request));
  }

  @Post(':id/close')
  @RequirePermissions('price_request.create')
  async close(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.close(companyId, id, actor, this.ctx(request));
  }

  @Post(':id/create-sale')
  @RequirePermissions('sales.create')
  async createSale(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSaleFromRequestDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.createSaleFromRequest(companyId, id, dto, actor, this.ctx(request));
  }

  @Post(':id/create-purchase')
  @RequirePermissions('purchase.create')
  async createPurchase(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreatePurchaseFromRequestDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.priceRequestsService.createPurchaseFromRequest(companyId, id, dto, actor, this.ctx(request));
  }

  // ── supplier offers ──

  @Post('lines/:lineId/offers')
  @RequirePermissions('price_request.manage_offers')
  async addOffer(
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: AddOfferDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.offersService.addOffer(companyId, lineId, dto, actor, this.ctx(request));
  }

  @Get('lines/:lineId/offers')
  @RequirePermissions('price_request.view')
  async listOffers(@Param('lineId', ParseUUIDPipe) lineId: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.offersService.listByLine(companyId, lineId);
  }

  @Patch('lines/:lineId/offers/:offerId')
  @RequirePermissions('price_request.manage_offers')
  async updateOffer(
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @Body() dto: UpdateOfferDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.offersService.updateOffer(companyId, lineId, offerId, dto, actor, this.ctx(request));
  }

  @Delete('lines/:lineId/offers/:offerId')
  @RequirePermissions('price_request.manage_offers')
  async deleteOffer(
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    await this.offersService.deleteOffer(companyId, lineId, offerId, actor, this.ctx(request));
    return { success: true };
  }
}
