import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { LoadingService } from './loading.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import {
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class LoadingAllocationDto {
  @IsOptional()
  @IsUUID()
  salesLineId?: string;

  @IsOptional()
  @IsUUID()
  purchaseLineId?: string;

  @IsNumber()
  @IsPositive()
  allocatedQuantity!: number;
}

export class LoadingLineDto {
  @IsUUID()
  productVariantId!: string;

  @IsNumber()
  @IsPositive()
  actualQuantity!: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => LoadingAllocationDto)
  allocations?: LoadingAllocationDto[];
}

export class CreateLoadingDto {
  @IsDateString()
  loadingDate!: string;

  @IsOptional()
  @IsUUID()
  driverPartyId?: string;

  @IsOptional()
  @IsUUID()
  carrierPartyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsArray()
  @MinLength(1)
  @ValidateNested({ each: true })
  @Type(() => LoadingLineDto)
  lines!: LoadingLineDto[];
}

@Controller('loadings')
export class LoadingController {
  constructor(
    private readonly loadingService: LoadingService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('loading.view')
  async list(
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.loadingService.list(
      companyId,
      from ? new Date(from) : undefined,
      to ? new Date(to) : undefined,
    );
  }

  @Post()
  @RequirePermissions('loading.create')
  async create(
    @Body() dto: CreateLoadingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.loadingService.create(
      companyId,
      {
        loadingDate: new Date(dto.loadingDate),
        driverPartyId: dto.driverPartyId,
        carrierPartyId: dto.carrierPartyId,
        notes: dto.notes,
        lines: dto.lines,
      },
      actor,
      this.ctx(request),
    );
  }

  @Get(':id')
  @RequirePermissions('loading.view')
  async getById(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.loadingService.getById(companyId, id);
  }
}
