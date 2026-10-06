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
import { AllocationsService } from './allocations.service';
import { AllocationQueryDto, CreateAllocationDto, UpdateAllocationDto } from './allocations.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/** Sales ↔ Purchase line-level allocations (REQUIREMENTS §12). */
@Controller('allocations')
export class AllocationsController {
  constructor(
    private readonly allocationsService: AllocationsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('allocations.manage')
  async create(
    @Body() dto: CreateAllocationDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.allocationsService.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('allocations.manage')
  async list(@Query() query: AllocationQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.allocationsService.list(companyId, query);
  }

  @Patch(':id')
  @RequirePermissions('allocations.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAllocationDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.allocationsService.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('allocations.manage')
  async delete(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.allocationsService.delete(companyId, id, actor, this.ctx(request));
    return { success: true };
  }
}
