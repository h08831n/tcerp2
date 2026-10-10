import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class StockQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;
}

/** Movement source entity types (polymorphic — see StockMovement schema). */
export const MOVEMENT_SOURCE_TYPES = [
  'PURCHASE_RECEIPT',
  'LOADING',
  'LOADING_REVERSAL',
  'RECEIPT_REVERSAL',
  'TRANSFER',
] as const;

export class MovementQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;

  @IsOptional()
  @IsIn(MOVEMENT_SOURCE_TYPES)
  sourceEntityType?: (typeof MOVEMENT_SOURCE_TYPES)[number];

  @IsOptional()
  @IsUUID()
  sourceEntityId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class LocationQueryDto {
  @IsOptional()
  @IsIn(['SUPPLIER', 'INTERNAL', 'CUSTOMER', 'TRANSIT'])
  type?: 'SUPPLIER' | 'INTERNAL' | 'CUSTOMER' | 'TRANSIT';

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateTransferDto {
  @IsUUID()
  variantId!: string;

  @IsNumber()
  @IsPositive()
  quantity!: number;

  @IsUUID()
  uomId!: string;

  @IsUUID()
  fromWarehouseId!: string;

  @IsUUID()
  toWarehouseId!: string;
}

export class CreateWarehouseDto {
  @IsString()
  @MaxLength(50)
  code!: string;

  @IsString()
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateWarehouseDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string | null;

  /** Demoting the current default is allowed (transiently no default, like
   *  the UOM base-unit precedent); promoting a second one is a 409. */
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
