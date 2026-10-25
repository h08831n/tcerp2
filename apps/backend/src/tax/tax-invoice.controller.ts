import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { TaxInvoiceService } from './tax-invoice.service';
import { SalesTaxInvoiceStatus } from '@prisma/client';

export class LineSstidDto {
  @IsUUID()
  salesLineId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50)
  sstid!: string;
}

export class CreateTaxInvoiceDto {
  @IsUUID()
  salesDocumentId!: string;

  @IsOptional()
  @IsIn(['MAIN', 'CORRECTIVE', 'CANCEL', 'RETURN'])
  subject?: 'MAIN' | 'CORRECTIVE' | 'CANCEL' | 'RETURN';

  @IsOptional()
  @IsDateString()
  issueDate?: string;

  /** official جدول ۲: sstid (کد کالا/خدمت) is REQUIRED per line — the caller
   *  supplies the product→goods-code mapping resolved from the registered
   *  goods list; unmapped lines block submission. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LineSstidDto)
  lineSstids?: LineSstidDto[];
}

export class AssignLineSstidDto {
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  sstid!: string;
}

export class TaxInvoiceQueryDto {
  @IsOptional()
  @IsIn(['DRAFT', 'READY', 'SENDING', 'SUBMITTED', 'SUCCESS', 'FAILED', 'CANCELLED'])
  status?: SalesTaxInvoiceStatus;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  page?: string;

  @IsOptional()
  pageSize?: string;
}

export class RegisterPurchaseTaxInvoiceDto {
  @IsUUID()
  supplierPartyId!: string;

  @IsString()
  @MaxLength(50)
  supplierInvoiceNumber!: string;

  @IsDateString()
  invoiceDate!: string;

  @IsString()
  total!: string;

  @IsString()
  taxTotal!: string;
}

/**
 * Phase 8 — Tax invoices & Moadian. Permissions: `tax.view` for reads,
 * `tax.edit` for creation, `tax.submit` (Phase 8 addition) for sending to the
 * authority / purchase registration. Backend-enforced via the global guard —
 * the salesperson role holds none of these (REQUIREMENTS: salesperson has no
 * tax invoice access).
 */
@Controller('tax/invoices')
export class TaxInvoiceController {
  constructor(
    private readonly taxInvoices: TaxInvoiceService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get()
  @RequirePermissions('tax.view')
  async list(@Query() query: TaxInvoiceQueryDto, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.list(companyId, {
      status: query.status,
      customerId: query.customerId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @Get(':id')
  @RequirePermissions('tax.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.getById(companyId, id);
  }

  @Post('from-sales')
  @RequirePermissions('tax.edit')
  async createFromSales(
    @Body() dto: CreateTaxInvoiceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.createFromSalesDocument(
      companyId,
      {
        salesDocumentId: dto.salesDocumentId,
        subject: dto.subject,
        issueDate: dto.issueDate ? new Date(dto.issueDate) : undefined,
        lineSstids: dto.lineSstids,
      },
      actor,
    );
  }

  @Post(':id/send')
  @RequirePermissions('tax.submit')
  async send(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.send(companyId, id, actor);
  }

  @Post('lines/:lineId/sstid')
  @RequirePermissions('tax.edit')
  async assignLineSstid(
    @Param('lineId', ParseUUIDPipe) lineId: string,
    @Body() dto: AssignLineSstidDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.taxInvoices.assignLineSstid(companyId, lineId, dto.sstid, actor);
    return { status: 'ASSIGNED', lineId, sstid: dto.sstid };
  }

  @Post(':id/inquiry')
  @RequirePermissions('tax.submit')
  async inquiry(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.inquiry(companyId, id);
  }

  @Get('sales-document/:salesDocumentId/moadian-status')
  @RequirePermissions('tax.view')
  async salesDocumentStatus(
    @Param('salesDocumentId', ParseUUIDPipe) salesDocumentId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.salesDocumentMoadianStatus(companyId, salesDocumentId);
  }

  @Post('purchase')
  @RequirePermissions('tax.submit')
  async registerPurchase(
    @Body() dto: RegisterPurchaseTaxInvoiceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.registerPurchase(
      companyId,
      {
        supplierPartyId: dto.supplierPartyId,
        supplierInvoiceNumber: dto.supplierInvoiceNumber,
        invoiceDate: new Date(dto.invoiceDate),
        total: dto.total,
        taxTotal: dto.taxTotal,
      },
      actor,
    );
  }

  @Get('purchase')
  @RequirePermissions('tax.view')
  async listPurchase(
    @Query() query: { page?: string; pageSize?: string; supplierId?: string },
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.taxInvoices.listPurchase(companyId, {
      supplierId: query.supplierId,
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }
}
