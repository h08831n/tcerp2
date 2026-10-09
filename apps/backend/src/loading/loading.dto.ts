import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

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
  warehouseId?: string;

  /** Optional customer-facing side (debt gate REQUIREMENTS §20). */
  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

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
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => LoadingLineDto)
  lines!: LoadingLineDto[];
}

export class UpdateLoadingDto {
  /** Optimistic concurrency without a version column: pass the `updatedAt`
   *  the caller read; a mismatch is a 409 VERSION_CONFLICT. */
  @IsOptional()
  @IsDateString()
  expectedUpdatedAt?: string;

  @IsOptional()
  @IsDateString()
  loadingDate?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string | null;

  @IsOptional()
  @IsUUID()
  customerPartyId?: string | null;

  @IsOptional()
  @IsUUID()
  driverPartyId?: string | null;

  @IsOptional()
  @IsUUID()
  carrierPartyId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  /** Full-replace: when absent the existing lines are kept untouched. */
  @IsOptional()
  @IsArray()
  @MinLength(1)
  @ValidateNested({ each: true })
  @Type(() => LoadingLineDto)
  lines?: LoadingLineDto[];
}

export class LoadingQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['DRAFT', 'CONFIRMED', 'CANCELLED'])
  status?: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsUUID()
  customerPartyId?: string;
}

export class ReleaseDriverInfoDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}
