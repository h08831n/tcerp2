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
import { SupplierMappingsService } from './supplier-mappings.service';
import {
  CreateSupplierMappingDto,
  SupplierMappingQueryDto,
  UpdateSupplierMappingDto,
} from './products.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Three-level supplier ↔ product mappings at /api/products/supplier-mappings
 * (the older /api/supplier-products endpoint from the Correction Gate remains
 * for compatibility; this one adds SUPPLIER-role and same-company FK checks).
 */
@Controller('products/supplier-mappings')
export class SupplierMappingsController {
  constructor(
    private readonly mappings: SupplierMappingsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('products.supplier_mapping.manage')
  async create(
    @Body() dto: CreateSupplierMappingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.mappings.create(companyId, dto, actor, this.ctx(request));
  }

  @Get()
  @RequirePermissions('products.view')
  async list(
    @Query() query: SupplierMappingQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.mappings.list(companyId, query);
  }

  @Patch(':id')
  @RequirePermissions('products.supplier_mapping.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierMappingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.mappings.update(companyId, id, dto, actor, this.ctx(request));
  }
}
