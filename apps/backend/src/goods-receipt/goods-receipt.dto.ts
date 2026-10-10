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

export class GoodsReceiptLineDto {
  @IsUUID()
  purchaseLineId!: string;

  /** The ACTUAL physical quantity received (over-receipt allowed, flagged). */
  @IsNumber()
  @IsPositive()
  actualQuantity!: number;

  @IsUUID()
  uomId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class CreateGoodsReceiptDto {
  @IsUUID()
  purchaseDocumentId!: string;

  /** Either an explicit INTERNAL location or a warehouse (its LOC- location). */
  @IsOptional()
  @IsUUID()
  destinationLocationId?: string;

  @IsOptional()
  @IsUUID()
  warehouseId?: string;

  @IsOptional()
  @IsDateString()
  receiptDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GoodsReceiptLineDto)
  lines!: GoodsReceiptLineDto[];
}

export class ReverseGoodsReceiptDto {
  @IsString()
  @MinLength(1)
  reason!: string;
}

export class GoodsReceiptQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['DRAFT', 'CONFIRMED', 'REVERSED', 'CANCELLED'])
  status?: 'DRAFT' | 'CONFIRMED' | 'REVERSED' | 'CANCELLED';

  @IsOptional()
  @IsUUID()
  purchaseDocumentId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
