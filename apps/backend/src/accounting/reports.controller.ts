import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsArray, IsDateString, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { Req } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { ReportsService } from './reports.service';
import { ProfitReportService } from './profit-report.service';
import { ValuationReportService } from './valuation-report.service';
import { SubsidiaryLedgerService } from './subsidiary-ledger.service';
import { OpeningBalanceService, OpeningBalanceRowInput } from './opening-balance.service';

class OpeningRowDto {
  @IsString()
  accountCode!: string;

  @IsOptional()
  @IsString()
  partyId?: string | null;

  @IsOptional()
  @IsString()
  partyName?: string | null;

  @IsOptional()
  @IsString()
  productVariantId?: string | null;

  @IsOptional()
  quantity?: number | string | null;

  @IsOptional()
  unitCost?: number | string | null;

  @IsOptional()
  debit?: number | string | null;

  @IsOptional()
  credit?: number | string | null;

  @IsOptional()
  @IsString()
  note?: string | null;
}

class StageOpeningDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OpeningRowDto)
  rows!: OpeningRowDto[];
}

class GenerateOpeningDto {
  @IsOptional()
  @IsDateString()
  entryDate?: string;
}

@Controller('accounting/reports')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly profit: ProfitReportService,
    private readonly valuation: ValuationReportService,
    private readonly subsidiary: SubsidiaryLedgerService,
    private readonly opening: OpeningBalanceService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get('general-ledger')
  @RequirePermissions('accounting.report')
  async generalLedger(
    @Query('accountCode') accountCode: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.reports.generalLedger(companyId, {
      accountCode,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('trial-balance')
  @RequirePermissions('accounting.report')
  async trialBalance(
    @Query('asOf') asOf: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.reports.trialBalance(companyId, asOf ? new Date(asOf) : new Date());
  }

  @Get('subsidiary-ledger')
  @RequirePermissions('accounting.report')
  async subsidiaryBalances(
    @Query('role') role: 'CUSTOMER' | 'SUPPLIER',
    @Query('accountCode') accountCode: string,
    @Query('asOf') asOf: string | undefined,
    @Query('search') search: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.subsidiary.partyBalances(companyId, {
      role: role === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER',
      accountCode: accountCode || (role === 'SUPPLIER' ? 'PAYABLE' : 'RECEIVABLE'),
      asOf: asOf ? new Date(asOf) : undefined,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('subsidiary-ledger/:partyId')
  @RequirePermissions('accounting.report')
  async subsidiaryLedger(
    @Param('partyId', ParseUUIDPipe) partyId: string,
    @Query('accountCode') accountCode: string | undefined,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.subsidiary.partyLedger(companyId, partyId, {
      accountCode: accountCode || 'RECEIVABLE',
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  @Get('responsibility-group/:responsiblePartyId')
  @RequirePermissions('accounting.report')
  async responsibilityGroup(
    @Param('responsiblePartyId', ParseUUIDPipe) responsiblePartyId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.subsidiary.responsibilityGroup(companyId, responsiblePartyId);
  }

  @Get('operational-profit')
  @RequirePermissions('accounting.report')
  async operationalProfit(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('customerId') customerId: string | undefined,
    @Query('salespersonUserId') salespersonUserId: string | undefined,
    @Query('productVariantId') productVariantId: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.profit.operationalProfit(companyId, {
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      customerId,
      salespersonUserId,
      productVariantId,
    });
  }

  @Get('inventory-valuation')
  @RequirePermissions('accounting.report')
  async inventoryValuation(
    @Query('warehouseId') warehouseId: string | undefined,
    @Query('categoryId') categoryId: string | undefined,
    @Query('search') search: string | undefined,
    @Query('page') page: string | undefined,
    @Query('pageSize') pageSize: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.valuation.valuation(companyId, {
      warehouseId,
      categoryId,
      search,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('inventory-valuation/:variantId/history')
  @RequirePermissions('accounting.report')
  async variantHistory(
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.valuation.variantHistory(companyId, variantId);
  }
}

@Controller('accounting/opening-balance')
export class OpeningBalanceController {
  constructor(
    private readonly opening: OpeningBalanceService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get()
  @RequirePermissions('accounting.report')
  async list(@CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.opening.list(companyId);
  }

  @Post('stage')
  @RequirePermissions('accounting.fiscal.manage')
  async stage(
    @Body() dto: StageOpeningDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    this.opening.assertStagedBalanced(dto.rows);
    return this.opening.stage(companyId, dto.rows, actor);
  }

  @Post('generate')
  @RequirePermissions('accounting.fiscal.manage')
  async generate(
    @Body() dto: GenerateOpeningDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.opening.generate(companyId, actor, dto.entryDate ? new Date(dto.entryDate) : undefined);
  }
}
