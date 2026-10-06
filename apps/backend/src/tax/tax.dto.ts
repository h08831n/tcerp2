import {
  IsBoolean,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateTaxDefinitionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsNumber()
  @IsPositive()
  rate!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateTaxDefinitionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  rate?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class AllocateSalesTaxDto {
  @IsUUID()
  salesTaxInvoiceId!: string;

  @IsUUID()
  salesDocumentId!: string;

  @IsNumber()
  @IsPositive()
  allocatedAmount!: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  allocatedQuantity?: number;
}

export class AllocatePurchaseTaxDto {
  @IsUUID()
  purchaseTaxInvoiceId!: string;

  @IsUUID()
  purchaseDocumentId!: string;

  @IsNumber()
  @IsPositive()
  allocatedAmount!: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  allocatedQuantity?: number;
}
