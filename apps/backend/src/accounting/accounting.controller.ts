import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { AccountingEventType } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AccountingEventService } from './accounting-event.service';
import { PostingRuleService } from './posting-rule.service';
import { Request } from 'express';
import { Req } from '@nestjs/common';

class EventQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(Object.values(AccountingEventType))
  eventType?: AccountingEventType;

  @IsOptional()
  @IsIn(['POSTED', 'FAILED', 'SKIPPED'])
  status?: 'POSTED' | 'FAILED' | 'SKIPPED';
}

class UpsertRuleDto {
  @IsString()
  @MaxLength(60)
  code!: string;

  @IsString()
  @MaxLength(120)
  nameFa!: string;

  @IsIn(Object.values(AccountingEventType))
  eventType!: AccountingEventType;

  @IsOptional()
  enabled?: boolean;

  @IsOptional()
  lines?: {
    side: 'DEBIT' | 'CREDIT';
    accountCode: string;
    measure: string;
    memo?: string;
    order?: number;
  }[];
}

class RuleStatusDto {
  @IsString()
  enabled!: boolean;
}

@Controller('accounting')
export class AccountingController {
  constructor(
    private readonly events: AccountingEventService,
    private readonly rules: PostingRuleService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get('events')
  @RequirePermissions('accounting.posting.manage')
  async listEvents(
    @Query() query: EventQueryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.events.list(companyId, query);
  }

  @Post('events/:id/post')
  @RequirePermissions('accounting.posting.manage')
  async retryEvent(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.events.retry(companyId, id);
  }

  @Get('rules')
  @RequirePermissions('accounting.posting.manage')
  async listRules(
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.rules.list(companyId);
  }

  @Post('rules')
  @RequirePermissions('accounting.posting.manage')
  async upsertRule(
    @Body() dto: UpsertRuleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.rules.upsert(companyId, dto, actor);
  }

  @Post('rules/:id/status')
  @RequirePermissions('accounting.posting.manage')
  async setRuleStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RuleStatusDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.rules.setEnabled(companyId, id, dto.enabled, actor);
  }
}
