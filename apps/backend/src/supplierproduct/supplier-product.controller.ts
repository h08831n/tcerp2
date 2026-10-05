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
import { SupplierProductService } from './supplier-product.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SupplierMappingLevel } from '@prisma/client';

export class CreateSupplierProductDto {
  @IsUUID()
  supplierPartyId!: string;

  @IsEnum(SupplierMappingLevel)
  mappingLevel!: SupplierMappingLevel;

  @IsOptional()
  @IsUUID()
  productVariantId?: string;

  @IsOptional()
  @IsUUID()
  productTemplateId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierProductCode?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSupplierProductDto extends CreateSupplierProductDto {}

@Controller('supplier-products')
export class SupplierProductController {
  constructor(
    private readonly supplierProducts: SupplierProductService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('supplierproduct.view')
  async list(
    @Query('supplierPartyId') supplierPartyId: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.supplierProducts.list(companyId, supplierPartyId);
  }

  @Post()
  @RequirePermissions('supplierproduct.create')
  async create(
    @Body() dto: CreateSupplierProductDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.supplierProducts.create(companyId, dto, actor, this.ctx(request));
  }

  @Patch(':id')
  @RequirePermissions('supplierproduct.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSupplierProductDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.supplierProducts.update(companyId, id, dto, actor, this.ctx(request));
  }
}
