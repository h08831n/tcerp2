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
import { ClaimsService } from './claims.service';
import { CreateClaimDto, MatchClaimDto, RejectClaimDto } from './claims.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('claims.view')
  async list(
    @Query('status') status: 'UNMATCHED' | 'MATCHED' | 'REJECTED' | undefined,
    @Query('partyId') partyId: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.claimsService.list(companyId, { status, partyId });
  }

  @Post()
  @RequirePermissions('claims.create')
  async create(
    @Body() dto: CreateClaimDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.claimsService.createAndAudit(companyId, dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('claims.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.claimsService.getById(companyId, id);
  }

  /** Reject an UNMATCHED claim (restores the operational balance). */
  @Post(':id/reject')
  @RequirePermissions('claims.edit')
  async reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectClaimDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.claimsService.reject(companyId, id, dto.reason, actor, this.ctx(request));
  }

  /** Match an UNMATCHED claim to a receipt / payment. */
  @Post(':id/match')
  @RequirePermissions('claims.edit')
  async match(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: MatchClaimDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.claimsService.match(companyId, id, dto, actor, this.ctx(request));
  }
}
