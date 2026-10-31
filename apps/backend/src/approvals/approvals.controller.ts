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
import { ApprovalRequestService, ApprovalViewer } from './approvals.service';
import {
  ApprovalQueryDto,
  CancelApprovalDto,
  CreateApprovalDto,
  DecideApprovalDto,
} from './approvals.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ForbiddenError } from '../common/errors';

/**
 * Generalized approval endpoints (Phase 6 lean + Phase 9B). The decision
 * surface stays `approvals.decide`-gated; the request surface is open to
 * `approvals.request` holders; list/detail scope is ALL for decide/view_all
 * holders and OWN (requestedBy/approverId) otherwise. Since
 * RequirePermissions is ALL-of semantics, any-of surfaces resolve the
 * effective permission set explicitly (same pattern as the activities
 * controller).
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalRequestService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  private async viewer(
    userId: string,
    companyId: string,
  ): Promise<ApprovalViewer> {
    const effective = await this.permissionsService.getEffectivePermissions(userId, companyId);
    const scopeAll =
      effective.has('approvals.decide') || effective.has('approvals.view_all');
    if (!scopeAll && !effective.has('approvals.request')) {
      throw new ForbiddenError('APPROVAL_VIEW_FORBIDDEN');
    }
    return { userId, scopeAll };
  }

  @Get()
  async list(
    @Query() query: ApprovalQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.approvals.list(companyId, query, await this.viewer(user.id, companyId));
  }

  @Get(':id')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.approvals.getById(companyId, id, await this.viewer(user.id, companyId));
  }

  @Post()
  async create(
    // Route gate (any-of semantics, resolved in-controller): a caller needs
    // approvals.request OR approvals.decide — an authenticated user with NONE
    // of them must never reach the service. The viewer() helper throws.
    @Body() dto: CreateApprovalDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.viewer(actor.id, companyId);
    return this.approvals.create(
      companyId,
      {
        entityType: dto.entityType,
        entityId: dto.entityId,
        approvalType: dto.approvalType,
        reason: dto.reason,
        dueAt: dto.dueAt,
        notifyRoles: dto.approverRoles,
      },
      actor,
      this.ctx(request),
    );
  }

  @Post(':id/decide')
  @RequirePermissions('approvals.decide')
  async decide(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DecideApprovalDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.approvals.decide(
      companyId,
      id,
      { decision: dto.decision, note: dto.note },
      actor,
      this.ctx(request),
    );
  }

  @Post(':id/cancel')
  async cancel(
    // Route gate (any-of, in-controller): approvals.request OR approvals.decide;
    // the service additionally restricts cancel to the requester or a decider.
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelApprovalDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    if (
      !effective.has('approvals.request') &&
      !effective.has('approvals.decide') &&
      !effective.has('approvals.view_all')
    ) {
      throw new ForbiddenError('APPROVAL_VIEW_FORBIDDEN');
    }
    return this.approvals.cancel(
      companyId,
      id,
      actor,
      effective.has('approvals.decide'),
      this.ctx(request),
      dto.reason,
    );
  }
}
