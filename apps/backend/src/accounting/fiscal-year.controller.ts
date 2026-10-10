import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { FiscalYearService, CreateFiscalYearInput } from './fiscal-year.service';
import { Request } from 'express';
import { Req } from '@nestjs/common';

class CreateFiscalYearDto {
  @IsString()
  @MaxLength(10)
  code!: string;

  @IsString()
  @MaxLength(100)
  nameFa!: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  generateMonthlyPeriods?: boolean;
}

class SetPeriodStatusDto {
  @IsString()
  status!: 'OPEN' | 'CLOSED';
}

@Controller('fiscal-years')
export class FiscalYearController {
  constructor(
    private readonly fiscalYearService: FiscalYearService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get()
  @RequirePermissions('accounting.fiscal.manage')
  async list(@CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.fiscalYearService.list(companyId);
  }

  @Get(':id')
  @RequirePermissions('accounting.fiscal.manage')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.fiscalYearService.getById(companyId, id);
  }

  @Post()
  @RequirePermissions('accounting.fiscal.manage')
  async create(
    @Body() dto: CreateFiscalYearDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.fiscalYearService.create(companyId, dto as CreateFiscalYearInput, actor);
  }

  @Post(':id/close')
  @RequirePermissions('accounting.fiscal.manage')
  async closeYear(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.fiscalYearService.closeYear(companyId, id, actor);
  }

  @Post(':id/periods/:periodId/status')
  @RequirePermissions('accounting.fiscal.manage')
  async setPeriodStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('periodId', ParseUUIDPipe) periodId: string,
    @Body() dto: SetPeriodStatusDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.fiscalYearService.setPeriodStatus(companyId, id, periodId, dto.status, actor);
  }
}
