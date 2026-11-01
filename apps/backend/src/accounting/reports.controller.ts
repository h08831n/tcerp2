import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { IsArray, IsDateString, IsOptional, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { Request } from 'express';
import { Req } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { ValidationError } from '../common/errors';
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

  /** P0-2: bind the staged batch to an OPEN fiscal year of this company. */
  @IsOptional()
  @IsUUID()
  fiscalYearId?: string;
}

class GenerateOpeningDto {
  @IsOptional()
  @IsDateString()
  entryDate?: string;

  /** P0-2: generate for this fiscal year explicitly (else: entryDate's FY). */
  @IsOptional()
  @IsUUID()
  fiscalYearId?: string;
}

/** R-4: assign legacy unassigned STAGED rows to an OPEN fiscal year. */
class AssignOpeningDto {
  @IsUUID()
  fiscalYearId!: string;
}

/**
 * P1-6 + R-5 (review of 96f9af0): report query dates are validated at the
 * controller boundary — an unparseable date reached Prisma as `Invalid Date`
 * (500), a reversed window silently returned misleading reports, and JS
 * `new Date` silently ROLLS calendar-invalid dates (2026-02-30 → March 2),
 * shifting report windows by days. Strict calendar round-trip check.
 */
function parseReportDate(value: string | undefined, field: string): Date | undefined {
  if (value === undefined || value === '') return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) throw new ValidationError('REPORT_DATE_INVALID', { field, value });
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ValidationError('REPORT_DATE_INVALID', { field, value });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ValidationError('REPORT_DATE_INVALID', { field, value });
  }
  return date;
}

function assertWindow(from: Date | undefined, to: Date | undefined): void {
  if (from && to && from.getTime() > to.getTime()) {
    throw new ValidationError('REPORT_RANGE_REVERSED', { from, to });
  }
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
    @Query('journalCode') journalCode: string | undefined,
    @Query('partyId') partyId: string | undefined,
    @Query('analyticType') analyticType: string | undefined,
    @Query('analyticId') analyticId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Query('cursor') cursor: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const fromDate = parseReportDate(from, 'from');
    const toDate = parseReportDate(to, 'to');
    assertWindow(fromDate, toDate);
    return this.reports.generalLedger(companyId, {
      accountCode,
      from: fromDate,
      to: toDate,
      journalCode: journalCode || undefined,
      partyId: partyId || undefined,
      analyticType: analyticType || undefined,
      analyticId: analyticId || undefined,
      limit: limit ? Number(limit) : undefined,
      cursor: cursor ?? null,
    });
  }

  /** Journal-entry drill-down for report rows (Phase 7D): read-only,
   *  company-scoped, exposes the entry with its lines and reversal linkage. */
  @Get('journal-entries/:id')
  @RequirePermissions('accounting.report')
  async journalEntry(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.reports.journalEntry(companyId, id);
  }

  @Get('trial-balance')
  @RequirePermissions('accounting.report')
  async trialBalance(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('asOf') asOf: string | undefined,
    @Query('level') level: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    // BUG-10: the service has always supported real windows and display
    // levels — the API now exposes them. Conflict rule is explicit: `asOf`
    // means "everything up to that date" (from = null, to = asOf) and is
    // rejected when combined with an explicit `to`.
    const fromDate = parseReportDate(from, 'from');
    const toDate = parseReportDate(to, 'to');
    const asOfDate = parseReportDate(asOf, 'asOf');
    if (toDate && asOfDate) {
      throw new ValidationError('TRIAL_BALANCE_ASOF_TO_CONFLICT', { to, asOf });
    }
    if (level && !['leaf', 'summary', 'all'].includes(level)) {
      throw new ValidationError('TRIAL_BALANCE_LEVEL_INVALID', { level });
    }
    assertWindow(fromDate, toDate ?? asOfDate);
    return this.reports.trialBalance(companyId, {
      from: fromDate,
      to: toDate,
      asOf: asOfDate,
      level: level as 'leaf' | 'summary' | 'all' | undefined,
    });
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
    const asOfDate = parseReportDate(asOf, 'asOf');
    return this.subsidiary.partyBalances(companyId, {
      role: role === 'SUPPLIER' ? 'SUPPLIER' : 'CUSTOMER',
      accountCode: accountCode || (role === 'SUPPLIER' ? 'PAYABLE' : 'RECEIVABLE'),
      asOf: asOfDate,
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
    const fromDate = parseReportDate(from, 'from');
    const toDate = parseReportDate(to, 'to');
    assertWindow(fromDate, toDate);
    return this.subsidiary.partyLedger(companyId, partyId, {
      accountCode: accountCode || 'RECEIVABLE',
      from: fromDate,
      to: toDate,
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
    @Query('supplierId') supplierId: string | undefined,
    @Query('salespersonUserId') salespersonUserId: string | undefined,
    @Query('productVariantId') productVariantId: string | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const fromDate = parseReportDate(from, 'from');
    const toDate = parseReportDate(to, 'to');
    assertWindow(fromDate, toDate);
    return this.profit.operationalProfit(companyId, {
      from: fromDate,
      to: toDate,
      customerId,
      // BUG-11: the service has always filtered by supplier — the controller
      // was dropping the parameter before it reached the service.
      supplierId,
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
    return this.opening.stage(companyId, dto.rows, actor, dto.fiscalYearId);
  }

  @Post('generate')
  @RequirePermissions('accounting.fiscal.manage')
  async generate(
    @Body() dto: GenerateOpeningDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.opening.generate(
      companyId,
      actor,
      parseReportDate(dto.entryDate, 'entryDate'),
      dto.fiscalYearId,
    );
  }

  @Post('assign')
  @RequirePermissions('accounting.fiscal.manage')
  async assign(
    @Body() dto: AssignOpeningDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return { assigned: await this.opening.assignTo(companyId, dto.fiscalYearId, actor) };
  }
}
