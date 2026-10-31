import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class CreateImportJobDto {
  @IsIn(['PARTY', 'DAILY_PRICE', 'PRODUCT_VARIANT'])
  entityType!: 'PARTY' | 'DAILY_PRICE' | 'PRODUCT_VARIANT';

  @IsOptional()
  @IsString()
  @MaxLength(200)
  fileName?: string;

  /** Raw CSV content (header row required). Mutually exclusive with xlsxBase64. */
  @IsOptional()
  @IsString()
  csv?: string;

  /** Base64-encoded .xlsx workbook (first worksheet used) — alternative to csv. */
  @IsOptional()
  @IsString()
  @MaxLength(30_000_000)
  xlsxBase64?: string;

  /** {field: csvHeader} — nameFa is mandatory. */
  @IsOptional()
  @IsObject()
  columnMapping?: Record<string, string>;

  /** Update existing parties matched by normalized phone (default: skip as duplicates). */
  @IsOptional()
  @IsBoolean()
  updateMatched?: boolean;

  /** PER_ROW (default, row-isolated) | BATCH (chunk all-or-nothing). */
  @IsOptional()
  @IsIn(['PER_ROW', 'BATCH'])
  commitMode?: 'PER_ROW' | 'BATCH';

  /** Rows per commit chunk (1..5000, default 500). */
  @IsOptional()
  @IsInt()
  @Min(1)
  batchSize?: number;
}

export class ImportJobQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['VALIDATED', 'RUNNING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'])
  status?:
    | 'VALIDATED'
    | 'RUNNING'
    | 'COMPLETED'
    | 'PARTIALLY_FAILED'
    | 'FAILED'
    | 'CANCELLED';
}
