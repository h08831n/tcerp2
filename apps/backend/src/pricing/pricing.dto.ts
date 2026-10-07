import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { DailyPriceSource } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

/** Modes for the bulk price update (REQUIREMENTS §17 Bulk Update). */
export type BulkPriceMode = 'PERCENT_UP' | 'PERCENT_DOWN' | 'FIXED_UP' | 'FIXED_DOWN';

export const BULK_PRICE_MODES: BulkPriceMode[] = [
  'PERCENT_UP',
  'PERCENT_DOWN',
  'FIXED_UP',
  'FIXED_DOWN',
];

export class UpsertDailyPriceDto {
  @IsUUID()
  productVariantId!: string;

  /** `YYYY-MM-DD` — TODAY upserts are free, past days need pricing.edit_history. */
  @IsString()
  date!: string;

  @IsUUID()
  uomId!: string;

  @IsNumber()
  @Min(0)
  price!: number;

  @IsOptional()
  @IsUUID()
  supplierPartyId?: string;

  @IsOptional()
  @IsIn(['MANUAL', 'SUPPLIER_OFFER', 'IMPORTED', 'API'])
  source?: DailyPriceSource;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class BulkPriceFilterDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;
}

export class BulkPriceUpdateDto {
  /** `YYYY-MM-DD` — bulk updates apply to TODAY's rows (create-or-update). */
  @IsString()
  date!: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(2000)
  @IsUUID('all', { each: true })
  variantIds?: string[];

  @IsOptional()
  @IsObject()
  filter?: BulkPriceFilterDto;

  @IsIn(BULK_PRICE_MODES)
  mode!: BulkPriceMode;

  /** Percent (PERCENT_*) or absolute amount (FIXED_*). */
  @IsNumber()
  amount!: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class DailyPriceHistoryQueryDto {
  @IsUUID()
  variantId!: string;

  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}

export class DailyPriceTodayQueryDto {
  @IsUUID()
  variantId!: string;

  @IsOptional()
  @IsUUID()
  uomId?: string;
}

/** Price grid: variant/template/category/brand + today's + yesterday's price. */
export class DailyPriceGridQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  date?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;
}

export class CheapestSupplierQueryDto {
  @IsUUID()
  variantId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days?: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;
}
