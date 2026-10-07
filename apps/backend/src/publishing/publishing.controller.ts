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
import { PublishingService } from './publishing.service';
import { PublishingTemplateService } from './publishing-template.service';
import {
  CreatePublishBatchDto,
  CreatePublishingTemplateDto,
  PublishBatchQueryDto,
  RenderPreviewDto,
  UpdatePublishingTemplateDto,
} from './publishing.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Publishing engine endpoints (Phase 5, REQUIREMENTS §18).
 * Reads: publishing.view; batches: pricing.publish; retry: publishing.retry;
 * cancel: publishing.cancel; templates: publishing.templates.manage.
 */
@Controller('publishing')
export class PublishingController {
  constructor(
    private readonly publishingService: PublishingService,
    private readonly templateService: PublishingTemplateService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  // ── batches ──

  @Get('batches')
  @RequirePermissions('publishing.view')
  async listBatches(@Query() query: PublishBatchQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.publishingService.listBatches(companyId, query);
  }

  @Get('batches/:id')
  @RequirePermissions('publishing.view')
  async getBatch(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.publishingService.getBatch(companyId, id);
  }

  @Post('batches')
  @RequirePermissions('pricing.publish')
  async createBatch(
    @Body() dto: CreatePublishBatchDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.publishingService.createBatch(companyId, dto, actor, this.ctx(request));
  }

  @Post('items/:id/retry')
  @RequirePermissions('publishing.retry')
  async retryItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.publishingService.retryItem(companyId, id, actor, this.ctx(request));
  }

  @Post('items/:id/cancel')
  @RequirePermissions('publishing.cancel')
  async cancelItem(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.publishingService.cancelItem(companyId, id, actor, this.ctx(request));
  }

  // ── templates ──

  @Get('templates')
  @RequirePermissions('publishing.view')
  async listTemplates(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templateService.list(companyId);
  }

  @Get('templates/:id')
  @RequirePermissions('publishing.view')
  async getTemplate(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templateService.getById(companyId, id);
  }

  @Post('templates')
  @RequirePermissions('publishing.templates.manage')
  async createTemplate(
    @Body() dto: CreatePublishingTemplateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templateService.create(companyId, dto, actor, this.ctx(request));
  }

  @Patch('templates/:id')
  @RequirePermissions('publishing.templates.manage')
  async updateTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePublishingTemplateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templateService.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete('templates/:id')
  @RequirePermissions('publishing.templates.manage')
  async deleteTemplate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.templateService.remove(companyId, id, actor, this.ctx(request));
    return { success: true };
  }

  @Post('templates/render-preview')
  @RequirePermissions('publishing.view')
  async renderPreview(@Body() dto: RenderPreviewDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templateService.renderPreview(companyId, dto);
  }
}
