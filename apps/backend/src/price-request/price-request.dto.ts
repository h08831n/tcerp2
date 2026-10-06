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
  Min,
  ValidateNested,
} from 'class-validator';
import { PriceRequestStatus } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

export class PriceRequestLineInputDto {
  @IsUUID()
  productVariantId: string;

  @IsNumber()
  @IsPositive()
  requestedQuantity: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreatePriceRequestDto {
  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsDateString()
  requestDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceRequestLineInputDto)
  lines?: PriceRequestLineInputDto[];
}

export class UpdatePriceRequestDto {
  @IsOptional()
  @IsUUID()
  customerPartyId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsInt()
  version: number;
}

export class AddPriceRequestLineDto extends PriceRequestLineInputDto {}

export class UpdatePriceRequestLineDto {
  @IsOptional()
  @IsUUID()
  productVariantId?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  requestedQuantity?: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class PriceRequestQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(PriceRequestStatus)
  status?: PriceRequestStatus;

  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

  @IsOptional()
  @IsUUID()
  requesterUserId?: string;
}

export class WorklistQueryDto {
  /** Day to build the worklist for (default: today, server time). */
  @IsOptional()
  @IsDateString()
  date?: string;
}

// ───────────────────────── supplier offers ─────────────────────────

export class AddOfferDto {
  @IsUUID()
  supplierPartyId: string;

  @IsNumber()
  @IsPositive()
  offeredPrice: number;

  /** Defaults to the request line's uom. */
  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  paymentTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  deliveryTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsDateString()
  offeredAt?: string;
}

export class UpdateOfferDto {
  @IsOptional()
  @IsNumber()
  @IsPositive()
  offeredPrice?: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  paymentTerms?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  deliveryTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

// ───────────────────── price request → sale/purchase ─────────────────────

export class RequestLineSelectionDto {
  @IsUUID()
  lineId: string;

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
}

export class CreateSaleFromRequestDto {
  /** Falls back to the request's customer; REQUIRED when it has none. */
  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

  @IsOptional()
  @IsUUID()
  salespersonUserId?: string;

  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string;

  /** All request lines when omitted. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RequestLineSelectionDto)
  lineSelections?: RequestLineSelectionDto[];
}

export class PurchaseLineSelectionDto {
  @IsUUID()
  lineId: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  quantity?: number;

  /** When given, the offer's price is copied as the purchase unit price. */
  @IsOptional()
  @IsUUID()
  offerId?: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;
}

export class CreatePurchaseFromRequestDto {
  @IsUUID()
  supplierPartyId: string;

  @IsOptional()
  @IsUUID()
  buyerUserId?: string;

  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string;

  /** All request lines when omitted. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PurchaseLineSelectionDto)
  lineSelections?: PurchaseLineSelectionDto[];
}

// ───────────────────── supplier intelligence (§15) ─────────────────────

export class DailyLowestQueryDto {
  /** Day to evaluate (default: today). */
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsUUID()
  variantId?: string;
}

export class LowestReportQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  days: number = 60;
}
