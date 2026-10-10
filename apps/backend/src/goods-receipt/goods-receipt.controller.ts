import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { GoodsReceiptService } from './goods-receipt.service';
import {
  CreateGoodsReceiptDto,
  GoodsReceiptQueryDto,
  ReverseGoodsReceiptDto,
} from './goods-receipt.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { DocumentRelationService } from '../document-flow/document-relation.service';

/**
 * Goods receipts (Integrity Gate #9):
 *   GET  /api/goods-receipts            — list (goods_receipt.view)
 *   GET  /api/goods-receipts/:id        — detail (goods_receipt.view)
 *   POST /api/goods-receipts            — DRAFT receipt (goods_receipt.create)
 *   POST /api/goods-receipts/:id/confirm — movements + purchase amounts
 *                                          (goods_receipt.confirm)
 *   POST /api/goods-receipts/:id/reverse — compensating movements, REQUIRED
 *                                          reason (goods_receipt.reverse)
 *   POST /api/goods-receipts/:id/cancel  — DRAFT → CANCELLED
 *                                          (goods_receipt.edit)
 *   GET  /api/goods-receipts/:id/relations — document-flow navigation
 *                                          (goods_receipt.view)
 */
@Controller('goods-receipts')
export class GoodsReceiptController {
  constructor(
    private readonly receipts: GoodsReceiptService,
    private readonly companyContext: CompanyContextService,
    private readonly relations: DocumentRelationService,
  ) {}

  private ctx(request: Request) {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('goods_receipt.view')
  async list(
    @Query() query: GoodsReceiptQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.receipts.list(companyId, query);
  }

  @Post()
  @RequirePermissions('goods_receipt.create')
  async create(
    @Body() dto: CreateGoodsReceiptDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.receipts.create(companyId, dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('goods_receipt.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.receipts.getById(companyId, id);
  }

  @Get(':id/relations')
  @RequirePermissions('goods_receipt.view')
  async listRelations(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.relations.listRelations(companyId, 'goods_receipt', id);
  }

  @Post(':id/confirm')
  @RequirePermissions('goods_receipt.confirm')
  async confirm(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.receipts.confirm(companyId, id, actor, this.ctx(request));
  }

  @Post(':id/reverse')
  @RequirePermissions('goods_receipt.reverse')
  async reverse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseGoodsReceiptDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.receipts.reverse(companyId, id, dto, actor, this.ctx(request));
  }

  @Post(':id/cancel')
  @RequirePermissions('goods_receipt.edit')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.receipts.cancel(companyId, id, actor, this.ctx(request));
  }
}
