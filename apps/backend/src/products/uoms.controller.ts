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
import { UomsService } from './uoms.service';
import { UomConversionService } from './uom-conversion.service';
import {
  CreateUomCategoryDto,
  CreateUomDto,
  UomConvertDto,
  UpdateUomCategoryDto,
  UpdateUomDto,
} from './products.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/** UOM engine: /api/uoms/categories + /api/uoms + /api/products/uom/convert. */
@Controller('uoms')
export class UomsController {
  constructor(
    private readonly uoms: UomsService,
    private readonly conversion: UomConversionService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  // ── uom categories ──

  @Post('categories')
  @RequirePermissions('products.uom.manage')
  async createCategory(
    @Body() dto: CreateUomCategoryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.uoms.createCategory(companyId, dto, actor, this.ctx(request));
  }

  @Get('categories')
  @RequirePermissions('products.view')
  async listCategories(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.uoms.listCategories(companyId);
  }

  @Patch('categories/:id')
  @RequirePermissions('products.uom.manage')
  async updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUomCategoryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.uoms.updateCategory(companyId, id, dto, actor, this.ctx(request));
  }

  // ── uoms ──

  @Post()
  @RequirePermissions('products.uom.manage')
  async createUom(
    @Body() dto: CreateUomDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.uoms.createUom(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('products.view')
  async listUoms(
    @Query('categoryId') categoryId: string | undefined,
    @Query('active') active: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.uoms.listUoms(companyId, {
      categoryId: categoryId || undefined,
      active: active === undefined ? undefined : active === 'true',
    });
  }

  @Patch(':id')
  @RequirePermissions('products.uom.manage')
  async updateUom(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUomDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.uoms.updateUom(companyId, id, dto, actor, this.ctx(request));
  }
}

/** Conversion endpoint lives under the /api/products prefix. */
@Controller('products/uom')
export class UomConversionController {
  constructor(
    private readonly conversion: UomConversionService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Post('convert')
  @RequirePermissions('products.view')
  async convert(
    @Body() dto: UomConvertDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    await this.companyContext.requireCompanyId(user, request.headers);
    return this.conversion.convert(dto.value, dto.fromUomId, dto.toUomId);
  }
}
