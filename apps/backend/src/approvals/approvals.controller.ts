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
import { ApprovalRequestService } from './approvals.service';
import { ApprovalQueryDto, DecideApprovalDto } from './approvals.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Lean approval endpoints (Phase 6). The whole surface is gated by
 * `approvals.decide` — approvers are exactly the roles holding it
 * (sales_manager / admin via the seed).
 */
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly approvals: ApprovalRequestService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('approvals.decide')
  async list(
    @Query() query: ApprovalQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.approvals.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('approvals.decide')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.approvals.getById(companyId, id);
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
}
