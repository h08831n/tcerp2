import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { SequencesService } from './sequences.service';
import { AllocateSequenceDto, CreateSequenceDto, UpdateSequenceDto } from './sequences.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

@Controller('sequences')
export class SequencesController {
  constructor(
    private readonly sequencesService: SequencesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('sequences.view')
  list(@CurrentUser() user: { id: string }, @Req() request: Request) {
    return this.companyContext
      .requireCompanyId(user, request.headers)
      .then((companyId) => this.sequencesService.list(companyId));
  }

  @Post()
  @RequirePermissions('sequences.edit')
  async createConfig(
    @Body() dto: CreateSequenceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.sequencesService.createConfig(companyId, dto, actor, this.ctx(request));
  }

  /** Admin/testing endpoint: allocate and return the next number. */
  @Post('allocate')
  @RequirePermissions('sequences.edit')
  async allocate(
    @Body() dto: AllocateSequenceDto,
    @CurrentUser() user: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.sequencesService.allocate(companyId, dto.documentType);
  }

  /** Prospective config change only — numbering history is never rewritten. */
  @Put(':id')
  @RequirePermissions('sequences.edit')
  async updateConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSequenceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.sequencesService.updateConfig(companyId, id, dto, actor, this.ctx(request));
  }
}
