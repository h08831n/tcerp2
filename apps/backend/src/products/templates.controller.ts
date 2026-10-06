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
import { TemplatesService } from './templates.service';
import {
  AddTemplateAttributeDto,
  CreateTemplateDto,
  GenerateVariantsDto,
  PreviewVariantsDto,
  SetTemplateAttributeValuesDto,
  TemplateQueryDto,
  UpdateTemplateAttributeDto,
  UpdateTemplateAttributeValueDto,
  UpdateTemplateDto,
  UpdateVariantDto,
} from './products.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/** Product templates + template attributes + variants + matrix (Phase 4 feed). */
@Controller('products/templates')
export class TemplatesController {
  constructor(
    private readonly templates: TemplatesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  // ── templates ──

  @Post()
  @RequirePermissions('products.create')
  async create(
    @Body() dto: CreateTemplateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('products.view')
  async list(
    @Query() query: TemplateQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templates.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('products.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templates.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('products.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTemplateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.update(companyId, id, dto, actor, this.ctx(request));
  }

  /** Soft archive (active=false). */
  @Delete(':id')
  @RequirePermissions('products.archive')
  async archive(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.archive(companyId, id, actor, this.ctx(request));
  }

  // ── template attributes (variant space definition) ──

  @Post(':id/attributes')
  @RequirePermissions('products.variants.manage')
  async addAttribute(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddTemplateAttributeDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.addAttribute(companyId, id, dto, actor, this.ctx(request));
  }

  @Patch(':id/attributes/:attributeId')
  @RequirePermissions('products.variants.manage')
  async updateAttribute(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
    @Body() dto: UpdateTemplateAttributeDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.updateAttribute(
      companyId,
      id,
      attributeId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Delete(':id/attributes/:attributeId')
  @RequirePermissions('products.variants.manage')
  async removeAttribute(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.removeAttribute(
      companyId,
      id,
      attributeId,
      actor,
      this.ctx(request),
    );
  }

  // ── template attribute SELECTED values (3B correction #2) ──

  /**
   * Body `{valueIds: [...]}` replaces the selected set; body `{valueId}`
   * adds a single value (idempotent).
   */
  @Post(':id/attributes/:attributeId/values')
  @RequirePermissions('products.variants.manage')
  async setAttributeValues(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
    @Body() dto: SetTemplateAttributeValuesDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.setTemplateAttributeValues(
      companyId,
      id,
      attributeId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Patch(':id/attributes/:attributeId/values/:valueId')
  @RequirePermissions('products.variants.manage')
  async updateAttributeValue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
    @Param('valueId', ParseUUIDPipe) valueId: string,
    @Body() dto: UpdateTemplateAttributeValueDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.updateTemplateAttributeValue(
      companyId,
      id,
      attributeId,
      valueId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Delete(':id/attributes/:attributeId/values/:valueId')
  @RequirePermissions('products.variants.manage')
  async removeAttributeValue(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attributeId', ParseUUIDPipe) attributeId: string,
    @Param('valueId', ParseUUIDPipe) valueId: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.removeTemplateAttributeValue(
      companyId,
      id,
      attributeId,
      valueId,
      actor,
      this.ctx(request),
    );
  }

  // ── variants ──

  @Post(':id/variants/preview')
  @RequirePermissions('products.variants.manage')
  async previewVariants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewVariantsDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templates.previewVariants(companyId, id, dto);
  }

  @Post(':id/variants/generate')
  @RequirePermissions('products.variants.manage')
  async generateVariants(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: GenerateVariantsDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.generateVariants(companyId, id, dto, actor, this.ctx(request));
  }

  /** PATCH one variant (weight per 3B correction #3, default UOM, name, active). */
  @Patch(':id/variants/:variantId')
  @RequirePermissions('products.edit')
  async updateVariant(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('variantId', ParseUUIDPipe) variantId: string,
    @Body() dto: UpdateVariantDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.updateVariant(
      companyId,
      id,
      variantId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Get(':id/matrix')
  @RequirePermissions('products.view')
  async matrix(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templates.matrix(companyId, id);
  }
}
