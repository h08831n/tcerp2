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
import { AttributesService } from './attributes.service';
import {
  CreateAttributeDto,
  CreateAttributeValueDto,
  UpdateAttributeDto,
  UpdateAttributeValueDto,
} from './products.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/** Dynamic attributes + values: /api/products/attributes(/attribute-values). */
@Controller('products/attributes')
export class AttributesController {
  constructor(
    private readonly attributes: AttributesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('products.attributes.manage')
  async create(
    @Body() dto: CreateAttributeDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.attributes.createAttribute(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('products.view')
  async list(
    @Query('active') active: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.attributes.listAttributes(companyId, {
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Patch(':id')
  @RequirePermissions('products.attributes.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttributeDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.attributes.updateAttribute(companyId, id, dto, actor, this.ctx(request));
  }
}

@Controller('products/attribute-values')
export class AttributeValuesController {
  constructor(
    private readonly attributes: AttributesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('products.attributes.manage')
  async create(
    @Body() dto: CreateAttributeValueDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.attributes.createValue(
      companyId,
      dto.attributeId,
      dto,
      actor,
      this.ctx(request),
    );
  }

  @Get()
  @RequirePermissions('products.view')
  async list(
    @Query('attributeId', ParseUUIDPipe) attributeId: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.attributes.listValues(companyId, attributeId);
  }

  @Patch(':id')
  @RequirePermissions('products.attributes.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAttributeValueDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.attributes.updateValue(companyId, id, dto, actor, this.ctx(request));
  }
}
