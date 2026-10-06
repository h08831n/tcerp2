import { Type, Transform } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
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
import { SalesDocumentStatus } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

/** Decimal inputs arrive as JSON numbers; math is done with Prisma.Decimal. */
export class SalesLineInputDto {
  @IsUUID()
  productVariantId: string;

  @IsNumber()
  @IsPositive()
  quantity: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsUUID()
  taxDefinitionId?: string;

  /** Printable description override (default: template name + attribute values). */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  printableDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreateSalesDocumentDto {
  @IsUUID()
  customerPartyId: string;

  @IsOptional()
  @IsUUID()
  salespersonUserId?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string;

  @IsOptional()
  @IsUUID()
  shippingAddressId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  quotationTemplateCode?: string;

  /** Reference only — never required (REQUIREMENTS §16). */
  @IsOptional()
  @IsUUID()
  priceRequestId?: string;

  @IsOptional()
  @IsIn(['DRAFT', 'QUOTATION'])
  status?: 'DRAFT' | 'QUOTATION';

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SalesLineInputDto)
  lines?: SalesLineInputDto[];
}

export class UpdateSalesDocumentDto {
  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsDateString()
  expirationDate?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string | null;

  @IsOptional()
  @IsUUID()
  shippingAddressId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  quotationTemplateCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  /** Optimistic locking (409 VERSION_CONFLICT on mismatch). */
  @IsInt()
  version: number;
}

export class MatrixCellDto {
  @IsUUID()
  productVariantId: string;

  /** Empty (quantity absent or ≤ 0) cells are skipped — never create lines. */
  @IsOptional()
  @IsNumber()
  quantity?: number;

  @IsOptional()
  @IsUUID()
  uomId?: string;

  @IsOptional()
  @IsNumber()
  unitPrice?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsUUID()
  taxDefinitionId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  printableDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreateLinesFromMatrixDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MatrixCellDto)
  cells: MatrixCellDto[];

  /** Required when editing a confirmed order WITH sales.override_confirmed_order. */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class AddSalesLineDto extends SalesLineInputDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  overrideReason?: string;
}

export class UpdateSalesLineDto {
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
  @IsNumber()
  @Min(0)
  discountAmount?: number;

  @IsOptional()
  @IsUUID()
  taxDefinitionId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  printableDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  overrideReason?: string;
}

export class LineOverrideDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  overrideReason?: string;
}

export class SalesDocumentQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(SalesDocumentStatus)
  status?: SalesDocumentStatus;

  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

  @IsOptional()
  @IsUUID()
  salespersonUserId?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  /** Derived filter: expirationDate < now AND status ∈ (QUOTATION, SENT). */
  @IsOptional()
  // Query params arrive as strings; normalize before @IsBoolean (parties
  // PartyQueryDto.archived precedent).
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  expired?: boolean;

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;
}

export class SendDocumentDto {}

export class LostDocumentDto {
  @IsUUID()
  lostReasonId: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class CreatePurchaseFromSaleDto {
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
}

export class CreateSaleFromPurchaseDto {
  @IsUUID()
  customerPartyId: string;

  @IsOptional()
  @IsUUID()
  salespersonUserId?: string;

  @IsOptional()
  @IsDateString()
  documentDate?: string;

  @IsOptional()
  @IsUUID()
  paymentTermId?: string;
}
