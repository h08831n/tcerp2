import { IsBoolean, IsInt, IsOptional, IsString, Max, Min, MinLength, MaxLength } from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class SequenceQueryDto extends PaginationDto {}

export class UpdateSequenceDto {
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
  @IsBoolean()
  includeJalaliYear?: boolean;

  @IsOptional()
  @IsBoolean()
  resetYearly?: boolean;
}
