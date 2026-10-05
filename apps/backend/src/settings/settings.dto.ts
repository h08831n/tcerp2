import { IsIn, IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class SettingQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  category?: string;
}

/** Well-known setting categories (REQUIREMENTS §67). */
export const SETTING_CATEGORIES = [
  'general',
  'company',
  'users',
  'security',
  'sales',
  'purchase',
  'products',
  'inventory',
  'accounting',
  'moadian',
  'notifications',
  'sms',
  'workflow',
  'automation',
  'templates',
  'sequences',
  'files',
  'integrations',
  'backup',
] as const;

export class UpsertSettingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  key: string;

  /** Arbitrary JSON value. */
  @IsObject()
  value: Record<string, unknown> | unknown;

  @IsOptional()
  @IsIn(SETTING_CATEGORIES as unknown as string[])
  category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(512)
  description?: string;
}
