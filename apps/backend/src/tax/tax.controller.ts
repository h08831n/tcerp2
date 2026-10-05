import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { TaxAllocationService, TaxDefinitionService } from './tax.service';
import {
  AllocatePurchaseTaxDto,
  AllocateSalesTaxDto,
  CreateTaxDefinitionDto,
  UpdateTaxDefinitionDto,
} from './tax.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

@Controller('tax')
export class TaxController {
  constructor(
    private readonly definitions: TaxDefinitionService,
    private readonly allocations: TaxAllocationService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  private async company(user: { id: string }, request: Request): Promise<string> {
    return this.companyContext.requireCompanyId(user, request.headers);
  }

  // ── Definitions ──
  @Get('definitions')
  @RequirePermissions('tax.view')
  async listDefinitions(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.company(user, request);
    return this.definitions.list(companyId);
  }

  @Post('definitions')
  @RequirePermissions('tax.create')
  async createDefinition(
    @Body() dto: CreateTaxDefinitionDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(actor, request);
    return this.definitions.create(companyId, dto, actor, this.ctx(request));
  }

  @Patch('definitions/:id')
  @RequirePermissions('tax.edit')
  async updateDefinition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaxDefinitionDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(actor, request);
    return this.definitions.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Post('definitions/:id/mark-used')
  @RequirePermissions('tax.edit')
  async markUsed(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(user, request);
    return { usedAt: await this.definitions.markUsed(companyId, id) };
  }

  // ── Allocations ──
  @Get('allocations/sales')
  @RequirePermissions('tax.view')
  async listSalesAllocations(
    @Query('salesTaxInvoiceId', ParseUUIDPipe) salesTaxInvoiceId: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(user, request);
    return this.allocations.listSalesByInvoice(companyId, salesTaxInvoiceId);
  }

  @Post('allocations/sales')
  @RequirePermissions('tax.edit')
  async allocateSales(
    @Body() dto: AllocateSalesTaxDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(user, request);
    return this.allocations.allocateSales({ companyId, ...dto });
  }

  @Get('allocations/purchase')
  @RequirePermissions('tax.view')
  async listPurchaseAllocations(
    @Query('purchaseTaxInvoiceId', ParseUUIDPipe) purchaseTaxInvoiceId: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(user, request);
    return this.allocations.listPurchaseByInvoice(companyId, purchaseTaxInvoiceId);
  }

  @Post('allocations/purchase')
  @RequirePermissions('tax.edit')
  async allocatePurchase(
    @Body() dto: AllocatePurchaseTaxDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.company(user, request);
    return this.allocations.allocatePurchase({ companyId, ...dto });
  }
}
