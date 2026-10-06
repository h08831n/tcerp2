import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { PortalAccountService } from './portal.service';
import { CreatePortalAccountDto, PortalAccountQueryDto } from './portal.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Minimal portal-account CRUD (Mini-Gate #3). Company-scoped through
 * CompanyContextService; permissions portalaccounts.view / portalaccounts.create.
 */
@Controller('portalaccounts')
export class PortalAccountsController {
  constructor(
    private readonly portalAccounts: PortalAccountService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('portalaccounts.view')
  list(@Query() query: PortalAccountQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.companyContext
      .requireCompanyId(user, request.headers)
      .then((companyId) => this.portalAccounts.list(companyId, query.status));
  }

  @Post()
  @RequirePermissions('portalaccounts.create')
  async create(
    @Body() dto: CreatePortalAccountDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.portalAccounts.create(companyId, dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('portalaccounts.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.portalAccounts.getById(companyId, id);
  }

  @Delete(':id')
  @RequirePermissions('portalaccounts.create')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.portalAccounts.remove(companyId, id, actor, this.ctx(request));
    return { success: true };
  }
}
