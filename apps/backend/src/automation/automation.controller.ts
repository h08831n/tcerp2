import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { AutomationRuleService } from './automation-rule.service';
import { AutomationService } from './automation.service';
import {
  AutomationRunQueryDto,
  CreateAutomationRuleDto,
  DailyScanRunDto,
  ManualRunDto,
  UpdateAutomationRuleDto,
} from './automation.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Automation endpoints (Phase 5, REQUIREMENTS §52 lean subset).
 * Reads: automation.view; rule CRUD / enable / manual run / scan run:
 * automation.manage.
 */
@Controller('automation')
export class AutomationController {
  constructor(
    private readonly ruleService: AutomationRuleService,
    private readonly automationService: AutomationService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get('rules')
  @RequirePermissions('automation.view')
  async listRules(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.ruleService.list(companyId);
  }

  @Post('rules')
  @RequirePermissions('automation.manage')
  async createRule(
    @Body() dto: CreateAutomationRuleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.ruleService.create(companyId, dto, actor, this.ctx(request));
  }

  @Get('rules/:id')
  @RequirePermissions('automation.view')
  async getRule(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.ruleService.getById(companyId, id);
  }

  @Patch('rules/:id')
  @RequirePermissions('automation.manage')
  async updateRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAutomationRuleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.ruleService.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete('rules/:id')
  @RequirePermissions('automation.manage')
  async deleteRule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.ruleService.remove(companyId, id, actor, this.ctx(request));
    return { success: true };
  }

  @Get('rules/:id/runs')
  @RequirePermissions('automation.view')
  async listRuns(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AutomationRunQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.ruleService.listRuns(companyId, id, query);
  }

  /** Manual run on one record (entityId) or a full scan of the rule. */
  @Post('rules/:id/run')
  @RequirePermissions('automation.manage')
  async runRule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualRunDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.automationService.manualRun(companyId, id, dto);
  }

  /** Manual daily-scan run across this company's enabled daily rules. */
  @Post('daily-scan/run')
  @RequirePermissions('automation.manage')
  async runDailyScan(
    @Body() dto: DailyScanRunDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const summaries = await this.automationService.dailyScan({ companyId, date: dto.date });
    return { date: dto.date ?? null, summaries };
  }
}
