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
import { PurchaseDocumentsService } from './purchase-documents.service';
import {
  AddPurchaseLineDto,
  CreatePurchaseDocumentDto,
  PurchaseDocumentQueryDto,
  UpdatePurchaseDocumentDto,
  UpdatePurchaseLineDto,
} from './purchase.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Purchase documents (Phase 4). Company-wide visibility for buyers — no
 * record scope (REQUIREMENTS §11). The cross-flow endpoint
 * POST /api/purchase/:id/create-sale lives in sales/flow.controller.ts.
 */

@Controller('purchase')
export class PurchaseController {
  constructor(
    private readonly purchaseService: PurchaseDocumentsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  private async companyIdOf(user: { id: string }, request: Request): Promise<string> {
    return this.companyContext.requireCompanyId(user, request.headers);
  }

  @Post()
  @RequirePermissions('purchase.create')
  async create(
    @Body() dto: CreatePurchaseDocumentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('purchase.view')
  async list(@Query() query: PurchaseDocumentQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.purchaseService.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('purchase.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(user, request);
    return this.purchaseService.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('purchase.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePurchaseDocumentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Post(':id/lines')
  @RequirePermissions('purchase.edit')
  async addLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddPurchaseLineDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.addLine(companyId, id, dto, actor, this.ctx(request));
  }

  @Patch(':id/lines/:lineId')
  @RequirePermissions('purchase.edit')
  async updateLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: UpdatePurchaseLineDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.updateLine(companyId, id, lineId, dto, actor, this.ctx(request));
  }

  @Delete(':id/lines/:lineId')
  @RequirePermissions('purchase.edit')
  async deleteLine(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.deleteLine(companyId, id, lineId, actor, this.ctx(request));
  }

  @Post(':id/place')
  @RequirePermissions('purchase.edit')
  async place(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.place(companyId, id, actor, this.ctx(request));
  }

  /**
   * DEPRECATED (Integrity Gate #9): blind PO-receipt is gone — the tombstone
   * answers 403 RECEIVE_DEPRECATED; real stock comes from goods receipts
   * (POST /api/goods-receipts).
   */
  @Post(':id/receive')
  @RequirePermissions('purchase.edit')
  async receive(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(actor, request);
    await this.purchaseService.receive(companyId, id);
    return { deprecated: true }; // unreachable — receive always throws
  }

  @Post(':id/complete')
  @RequirePermissions('purchase.edit')
  async complete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.complete(companyId, id, actor, this.ctx(request));
  }

  @Post(':id/cancel')
  @RequirePermissions('purchase.cancel')
  async cancel(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyIdOf(actor, request);
    return this.purchaseService.cancel(companyId, id, actor, this.ctx(request));
  }
}
