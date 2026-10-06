import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsPositive, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class CreateAllocationDto {
  @IsUUID()
  salesLineId: string;

  @IsUUID()
  purchaseLineId: string;

  @IsNumber()
  @IsPositive()
  allocatedQuantity: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateAllocationDto {
  @IsNumber()
  @IsPositive()
  allocatedQuantity: number;
}

export class AllocationQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  salesDocumentId?: string;

  @IsOptional()
  @IsUUID()
  purchaseDocumentId?: string;

  @IsOptional()
  @IsUUID()
  salesLineId?: string;

  @IsOptional()
  @IsUUID()
  purchaseLineId?: string;
}
