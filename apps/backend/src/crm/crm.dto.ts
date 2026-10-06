import { Type, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { LeadStatus, OpportunityStatus } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

// ───────────────────────────── Leads ─────────────────────────────

export class CreateLeadDto {
  @IsString()
  @MaxLength(256)
  name: string;

  @IsOptional()
  @IsUUID()
  partyId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  campaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  media?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  referrer?: string;

  @IsOptional()
  @IsUUID()
  assignedSalespersonId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}

export class UpdateLeadDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  name?: string;

  @IsOptional()
  @IsUUID()
  partyId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  campaign?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  media?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  referrer?: string;

  @IsOptional()
  @IsUUID()
  assignedSalespersonId?: string | null;

  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;

  @IsInt()
  version: number;
}

export class LeadQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  @IsOptional()
  @IsUUID()
  partyId?: string;

  @IsOptional()
  @IsUUID()
  assignedSalespersonId?: string;
}

// ───────────────────────── Opportunities ─────────────────────────

export class CreateOpportunityDto {
  @IsUUID()
  customerPartyId: string;

  @IsUUID()
  salespersonUserId: string;

  @IsString()
  @MaxLength(256)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsNumber()
  estimatedAmount?: number;

  @IsOptional()
  @IsNumber()
  estimatedTonnage?: number;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;
}

export class UpdateOpportunityDto {
  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

  @IsOptional()
  @IsUUID()
  salespersonUserId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  description?: string;

  @IsOptional()
  @IsNumber()
  estimatedAmount?: number;

  @IsOptional()
  @IsNumber()
  estimatedTonnage?: number;

  @IsOptional()
  @IsEnum(OpportunityStatus)
  status?: OpportunityStatus;

  /** REQUIRED when status → LOST. */
  @IsOptional()
  @IsUUID()
  lostReasonId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  source?: string;

  @IsInt()
  version: number;
}

export class OpportunityQueryDto extends PaginationDto {
  @IsOptional()
  @IsEnum(OpportunityStatus)
  status?: OpportunityStatus;

  @IsOptional()
  @IsUUID()
  customerPartyId?: string;

  @IsOptional()
  @IsUUID()
  salespersonUserId?: string;
}

// ───────────────────────── Lost reasons ──────────────────────────

export class CreateLostReasonDto {
  @IsString()
  @MaxLength(64)
  code: string;

  @IsString()
  @MaxLength(256)
  nameFa: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateLostReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameEn?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class LostReasonQueryDto extends PaginationDto {
  @IsOptional()
  // Query params arrive as strings; normalize before @IsBoolean.
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

// ───────────────────────── Payment terms ─────────────────────────

export class CreatePaymentTermDto {
  @IsString()
  @MaxLength(64)
  code: string;

  @IsString()
  @MaxLength(256)
  nameFa: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  daysOffset?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdatePaymentTermDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  nameEn?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  daysOffset?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class PaymentTermQueryDto extends PaginationDto {
  @IsOptional()
  // Query params arrive as strings; normalize before @IsBoolean.
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  active?: boolean;
}

// (The shared DateRangeDto was folded into the sales/purchase query DTOs.)
