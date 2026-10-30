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
import { WorkflowService } from './workflow.service';
import {
  CancelWorkflowInstanceDto,
  CreateWorkflowDefinitionDto,
  ExecuteTransitionDto,
  StartWorkflowInstanceDto,
  UpdateWorkflowDefinitionDto,
  WorkflowInstanceQueryDto,
} from './workflow.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';

/**
 * Workflow engine endpoints (Phase 9B, Gate E). Definition management is
 * `workflow.admin`; operating instances (start / transition / cancel) is
 * `workflow.start`; read surfaces are `workflow.view`. Per-transition
 * `requiredPermission` is checked server-side against the caller's
 * effective permission set inside executeTransition.
 */
@Controller('workflow')
export class WorkflowController {
  constructor(
    private readonly workflow: WorkflowService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  // ── Definitions ──

  @Post('definitions')
  @RequirePermissions('workflow.admin')
  async createDefinition(
    @Body() dto: CreateWorkflowDefinitionDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.workflow.createDefinition(companyId, dto, actor, this.ctx(request));
  }

  @Patch('definitions/:id')
  @RequirePermissions('workflow.admin')
  async updateDefinition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateWorkflowDefinitionDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.workflow.updateDefinition(companyId, id, dto, actor, this.ctx(request));
  }

  @Get('definitions')
  @RequirePermissions('workflow.view')
  async listDefinitions(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.workflow.listDefinitions(companyId);
  }

  @Get('definitions/:id')
  @RequirePermissions('workflow.view')
  async getDefinition(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.workflow.getDefinition(companyId, id);
  }

  // ── Instances ──

  @Post('instances')
  @RequirePermissions('workflow.start')
  async startInstance(
    @Body() dto: StartWorkflowInstanceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.workflow.startInstance(
      companyId,
      {
        definitionCode: dto.definitionCode,
        entityType: dto.entityType,
        entityId: dto.entityId,
        context: dto.context,
      },
      actor,
      this.ctx(request),
    );
  }

  @Get('instances')
  @RequirePermissions('workflow.view')
  async listInstances(
    @Query() query: WorkflowInstanceQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.workflow.listInstances(companyId, query);
  }

  @Get('instances/:id')
  @RequirePermissions('workflow.view')
  async getInstance(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.workflow.getInstance(companyId, id);
  }

  @Post('instances/:id/transition')
  @RequirePermissions('workflow.start')
  async executeTransition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExecuteTransitionDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    return this.workflow.executeTransition(
      companyId,
      id,
      { transitionCode: dto.transitionCode, note: dto.note },
      actor,
      effective,
      this.ctx(request),
    );
  }

  @Post('instances/:id/cancel')
  @RequirePermissions('workflow.start')
  async cancelInstance(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelWorkflowInstanceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    return this.workflow.cancelInstance(
      companyId,
      id,
      actor,
      effective.has('workflow.admin'),
      this.ctx(request),
      dto.reason,
    );
  }
}
