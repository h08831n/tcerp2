import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ImportsService } from './imports.service';
import { CreateImportJobDto, ImportJobQueryDto } from './imports.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Import/export endpoints (Phase 11, Gate G — handover §31).
 * - create/run/cancel: `imports.run` (operators)
 * - list/detail/rows/sample: `imports.view`
 * - parties CSV export: `imports.export` — the export is a company-wide dump
 *   (deliberate OWN-scope bypass) so it gets its own manager-only permission.
 */
@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('imports.run')
  async create(
    @Body() dto: CreateImportJobDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.imports.createJob(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('imports.view')
  async list(@Query() query: ImportJobQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.imports.listJobs(companyId, query);
  }

  @Get('sample')
  @RequirePermissions('imports.view')
  async sample(@Query('entityType') entityType: string | undefined, @Res() response: Response) {
    const csv = this.imports.sampleCsv(entityType ?? 'PARTY');
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="import-sample.csv"');
    response.send(`\uFEFF${csv}`); // BOM so Excel opens UTF-8 correctly
  }

  @Get(':id')
  @RequirePermissions('imports.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.imports.getJob(companyId, id);
  }

  @Get(':id/rows')
  @RequirePermissions('imports.view')
  async rows(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('problems') problems: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.imports.jobRows(companyId, id, problems !== 'false');
  }

  @Post(':id/run')
  @RequirePermissions('imports.run')
  async run(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.imports.run(companyId, id, actor, this.ctx(request));
  }

  @Post(':id/cancel')
  @RequirePermissions('imports.run')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.imports.cancel(companyId, id, actor, this.ctx(request));
    return { success: true };
  }
}

@Controller('exports')
export class ExportsController {
  constructor(
    private readonly imports: ImportsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  /** CSV export of the company's parties (UTF-8 BOM for Excel). */
  @Get('parties.csv')
  @RequirePermissions('imports.export')
  async exportParties(@CurrentUser() user: { id: string }, @Req() request: Request, @Res() response: Response) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const csv = await this.imports.exportPartiesCsv(companyId);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="parties.csv"');
    response.send(`\uFEFF${csv}`);
  }
}
