import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { PurchaseDocumentStatus } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

export class PurchaseLineInputDto {
  @IsUUID()
  productVariantId: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  /** Optional — defaults to the variant/template purchase uom. */
  @IsOptional()
  @IsUUID()
  uomId?: string;

  /** Defaults to 0 — the buyer fills prices (copies from sale start at 0). */
  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreatePurchaseDocumentDto {
  @IsUUID()
  supplierPartyId: string;

  @IsOptional()
  @IsUUID()
  buyerUserId?: string;

  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string;

  /** Reference only — never required (REQUIREMENTS §16). */
  @IsOptional()
  @IsUUID()
  priceRequestId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineInputDto)
  lines?: PurchaseLineInputDto[];
}

export class UpdatePurchaseDocumentDto {
  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsInt()
  version: number;
}

export class AddPurchaseLineDto extends PurchaseLineInputDto {}

export class UpdatePurchaseLineDto {
  @IsOptional()
  @IsUUID()
  productVariantId?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  quantity?: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class PurchaseDocumentQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(PurchaseDocumentStatus)
  status?: PurchaseDocumentStatus;

  @IsOptional()
  @IsUUID()
  supplierPartyId?: string;

  @IsOptional()
  @IsUUID()
  buyerUserId?: string;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}
