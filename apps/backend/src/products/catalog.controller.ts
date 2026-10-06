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
import { CategoriesService } from './categories.service';
import { BrandsService } from './brands.service';
import {
  BrandQueryDto,
  CreateBrandDto,
  CreateCategoryDto,
  CategoryQueryDto,
  UpdateBrandDto,
  UpdateCategoryDto,
} from './products.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Product catalog foundation: hierarchical categories + brands.
 * Route prefix decision (documented in README): categories live at
 * /api/categories and brands at /api/brands (short, top-level entities).
 */
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categories: CategoriesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('products.create')
  async create(
    @Body() dto: CreateCategoryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.categories.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('products.view')
  async list(@Query() query: CategoryQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.categories.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('products.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.categories.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('products.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.categories.update(companyId, id, dto, actor, this.ctx(request));
  }

  /** Hard delete — blocked while children/templates exist; archive instead. */
  @Delete(':id')
  @RequirePermissions('products.archive')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.categories.remove(companyId, id, actor, this.ctx(request));
  }
}

@Controller('brands')
export class BrandsController {
  constructor(
    private readonly brands: BrandsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('products.create')
  async create(
    @Body() dto: CreateBrandDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.brands.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('products.view')
  async list(@Query() query: BrandQueryDto, @CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.brands.list(companyId, query);
  }

  @Get(':id')
  @RequirePermissions('products.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.brands.getById(companyId, id);
  }

  @Patch(':id')
  @RequirePermissions('products.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBrandDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.brands.update(companyId, id, dto, actor, this.ctx(request));
  }
}
