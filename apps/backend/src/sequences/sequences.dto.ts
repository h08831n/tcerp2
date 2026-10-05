import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class SequenceQueryDto extends PaginationDto {}

const RESET_CYCLES = ['NEVER', 'FISCAL_YEAR', 'JALALI_YEAR', 'MONTHLY'] as const;

export class CreateSequenceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentType!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(16)
  prefix!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  padding?: number;

  @IsOptional()
  @IsIn(RESET_CYCLES)
  resetCycle?: (typeof RESET_CYCLES)[number];
}

export class UpdateSequenceDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(16)
  prefix?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(12)
  padding?: number;

  @IsOptional()
  @IsIn(RESET_CYCLES)
  resetCycle?: (typeof RESET_CYCLES)[number];
}

export class AllocateSequenceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  documentType!: string;
}
