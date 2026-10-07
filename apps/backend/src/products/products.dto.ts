import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDecimal,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ProductType, SupplierMappingLevel } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

// ───────────────────────────── categories ─────────────────────────────

export class CreateCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsUUID()
  parentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CategoryQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  parentId?: string;

  /** Default: only active. `active=false` → only archived; `active=any` → both. */
  @IsOptional()
  @IsIn(['true', 'false', 'any'])
  active?: 'true' | 'false' | 'any';
}

// ───────────────────────────── brands ─────────────────────────────

export class CreateBrandDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsUUID()
  logoAttachmentId?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsUUID()
  logoAttachmentId?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class BrandQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['true', 'false', 'any'])
  active?: 'true' | 'false' | 'any';
}

// ───────────────────────────── uoms ─────────────────────────────

export class CreateUomCategoryDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;
}

export class UpdateUomCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;
}

export class CreateUomDto {
  @IsUUID()
  categoryId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(16)
  symbol!: string;

  @IsDecimal({ decimal_digits: '0,6' })
  conversionRatio!: string;

  @IsOptional()
  @IsBoolean()
  isBaseUnit?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateUomDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsDecimal({ decimal_digits: '0,6' })
  conversionRatio?: string;

  @IsOptional()
  @IsBoolean()
  isBaseUnit?: boolean;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UomConvertDto {
  @IsDecimal({ decimal_digits: '0,10' })
  value!: string;

  @IsUUID()
  fromUomId!: string;

  @IsUUID()
  toUomId!: string;
}

// ───────────────────────────── attributes ─────────────────────────────

export class CreateAttributeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateAttributeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateAttributeValueDto {
  @IsUUID()
  attributeId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  valueFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  valueEn?: string;

  @IsOptional()
  @IsDecimal({ decimal_digits: '0,6' })
  numericValue?: string;

  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateAttributeValueDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  valueFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  valueEn?: string;

  @IsOptional()
  @IsDecimal({ decimal_digits: '0,6' })
  numericValue?: string;

  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

// ───────────────────────────── templates ─────────────────────────────

export class CreateTemplateDto {
  @IsUUID()
  categoryId!: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  internalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  @IsBoolean()
  isSellable?: boolean;

  @IsOptional()
  @IsBoolean()
  isPurchasable?: boolean;

  @IsOptional()
  @IsUUID()
  defaultSalesUomId?: string;

  @IsOptional()
  @IsUUID()
  defaultPurchaseUomId?: string;

  @IsOptional()
  @IsDecimal({ decimal_digits: '0,4' })
  defaultSalesPrice?: string;

  @IsOptional()
  @IsUUID()
  defaultTaxDefinitionId?: string;
}

export class UpdateTemplateDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string | null;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  internalCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  @IsBoolean()
  isSellable?: boolean;

  @IsOptional()
  @IsBoolean()
  isPurchasable?: boolean;

  @IsOptional()
  @IsUUID()
  defaultSalesUomId?: string;

  @IsOptional()
  @IsUUID()
  defaultPurchaseUomId?: string;

  @IsOptional()
  @IsDecimal({ decimal_digits: '0,4' })
  defaultSalesPrice?: string;

  @IsOptional()
  @IsUUID()
  defaultTaxDefinitionId?: string;

  @IsInt()
  version!: number;
}

export class TemplateQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  brandId?: string;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  /** Default: only active. `active=false` → only archived; `active=any` → both. */
  @IsOptional()
  @IsIn(['true', 'false', 'any'])
  active?: 'true' | 'false' | 'any';
}

// ───────────────────── template attributes ─────────────────────

export class AddTemplateAttributeDto {
  @IsUUID()
  attributeId!: string;

  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  createsVariants?: boolean;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}

export class UpdateTemplateAttributeDto {
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  createsVariants?: boolean;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;
}

// ───────────────────── variant preview / generation ─────────────────────

export class PreviewSelectionDto {
  @IsUUID()
  attributeId!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsUUID(undefined, { each: true })
  valueIds!: string[];
}

export class PreviewVariantsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => PreviewSelectionDto)
  selections!: PreviewSelectionDto[];
}

export class GenerateSelectionDto {
  @IsUUID()
  attributeId!: string;

  @IsUUID()
  valueId!: string;
}

export class GenerateCombinationDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerateSelectionDto)
  selections!: GenerateSelectionDto[];

  /** 3B correction #3 — optional unit weight; REQUIRES weightUomId. */
  @IsOptional()
  @IsDecimal({ decimal_digits: '0,4' })
  weightPerUnit?: string;

  /** 3B correction #3 — UOM of weightPerUnit; must be the company's Weight category. */
  @IsOptional()
  @IsUUID()
  weightUomId?: string;
}

export class GenerateVariantsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => GenerateCombinationDto)
  combinations!: GenerateCombinationDto[];
}

// ───────────────── template attribute selected values (3B correction #2) ────────────────

/**
 * POST /products/templates/:templateId/attributes/:attributeId/values —
 * exactly one of the two modes: `valueIds` REPLACES the selected set
 * (empty array clears it), `valueId` adds a single value (idempotent).
 */
export class SetTemplateAttributeValuesDto {
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  valueIds?: string[];

  @IsOptional()
  @IsUUID()
  valueId?: string;
}

/** PATCH displayOrder/active on one selected template attribute value. */
export class UpdateTemplateAttributeValueDto {
  @IsOptional()
  @IsInt()
  displayOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/** PATCH a variant (weight, default UOM, name, active) with optimistic locking. */
export class UpdateVariantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameFa?: string;

  @IsOptional()
  @IsUUID()
  defaultUomId?: string | null;

  /** 3B correction #3 — required to come with weightUomId when set. */
  @IsOptional()
  @IsDecimal({ decimal_digits: '0,4' })
  weightPerUnit?: string | null;

  @IsOptional()
  @IsUUID()
  weightUomId?: string | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;

  /**
   * p5c pricing-integrity review — public price-API visibility. false hides
   * the variant from every public price endpoint (ALL / PUBLISHED_ONLY
   * modes); see PublicApiService.
   */
  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsInt()
  version!: number;
}

// ───────────────────── supplier mappings ─────────────────────

export class CreateSupplierMappingDto {
  @IsUUID()
  supplierPartyId!: string;

  @IsEnum(SupplierMappingLevel)
  mappingLevel!: SupplierMappingLevel;

  @IsOptional()
  @IsUUID()
  productVariantId?: string;

  @IsOptional()
  @IsUUID()
  productTemplateId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierProductCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  supplierProductName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSupplierMappingDto {
  @IsOptional()
  @IsUUID()
  supplierPartyId?: string;

  @IsOptional()
  @IsEnum(SupplierMappingLevel)
  mappingLevel?: SupplierMappingLevel;

  @IsOptional()
  @IsUUID()
  productVariantId?: string;

  @IsOptional()
  @IsUUID()
  productTemplateId?: string;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  supplierProductCode?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  supplierProductName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SupplierMappingQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  supplierPartyId?: string;

  @IsOptional()
  @IsEnum(SupplierMappingLevel)
  mappingLevel?: SupplierMappingLevel;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
