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
import { LeadsService } from './leads.service';
import { OpportunitiesService } from './opportunities.service';
import { LostReasonsService } from './lost-reasons.service';
import { PaymentTermsService } from './payment-terms.service';
import {
  CreateLeadDto,
  CreateLostReasonDto,
  CreateOpportunityDto,
  CreatePaymentTermDto,
  LeadQueryDto,
  LostReasonQueryDto,
  OpportunityQueryDto,
  PaymentTermQueryDto,
  UpdateLeadDto,
  UpdateLostReasonDto,
  UpdateOpportunityDto,
  UpdatePaymentTermDto,
} from './crm.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * CRM funnel module (Phase 4): Leads, Opportunities, LostReasons,
 * PaymentTerms. All company-scoped; reads `crm.view`, writes `crm.manage`
 * (payment-term writes: `paymentterm.manage`).
 */

function ctxOf(request: Request): RequestContext {
  return { ip: request.ip, userAgent: request.headers['user-agent'] };
}

@Controller('leads')
export class LeadsController {
  constructor(
    private readonly leads: LeadsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Post()
  @RequirePermissions('crm.manage')
  async create(
    @Body() dto: CreateLeadDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.leads.create(companyId, dto, actor, ctxOf(request));
  }

  @Get()
  @RequirePermissions('crm.view')
  async list(@Query() query: LeadQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.leads.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('crm.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.leads.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('crm.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.leads.update(companyId, id, dto, actor, ctxOf(request));
  }

  @Delete(':id')
  @RequirePermissions('crm.manage')
  async delete(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.leads.archive(companyId, id, actor, ctxOf(request));
    return { success: true };
  }
}

@Controller('opportunities')
export class OpportunitiesController {
  constructor(
    private readonly opportunities: OpportunitiesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Post()
  @RequirePermissions('crm.manage')
  async create(
    @Body() dto: CreateOpportunityDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.opportunities.create(companyId, dto, actor, ctxOf(request));
  }

  @Get()
  @RequirePermissions('crm.view')
  async list(@Query() query: OpportunityQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.opportunities.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('crm.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.opportunities.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('crm.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateOpportunityDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.opportunities.update(companyId, id, dto, actor, ctxOf(request));
  }
}

@Controller('lost-reasons')
export class LostReasonsController {
  constructor(
    private readonly lostReasons: LostReasonsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Post()
  @RequirePermissions('crm.manage')
  async create(
    @Body() dto: CreateLostReasonDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.lostReasons.create(companyId, dto, actor, ctxOf(request));
  }

  @Get()
  @RequirePermissions('crm.view')
  async list(@Query() query: LostReasonQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.lostReasons.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('crm.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.lostReasons.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('crm.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLostReasonDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.lostReasons.update(companyId, id, dto, actor, ctxOf(request));
  }
}

@Controller('payment-terms')
export class PaymentTermsController {
  constructor(
    private readonly paymentTerms: PaymentTermsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Post()
  @RequirePermissions('paymentterm.manage')
  async create(
    @Body() dto: CreatePaymentTermDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.paymentTerms.create(companyId, dto, actor, ctxOf(request));
  }

  @Get()
  @RequirePermissions('crm.view')
  async list(@Query() query: PaymentTermQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.paymentTerms.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('crm.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.paymentTerms.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('paymentterm.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePaymentTermDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.paymentTerms.update(companyId, id, dto, actor, ctxOf(request));
  }
}
