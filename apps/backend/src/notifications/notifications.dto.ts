import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateNotificationRuleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  event!: string;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsArray()
  recipientConfig!: { type: 'ROLE' | 'USER' | 'RECORD_OWNER'; value: string }[];

  @IsArray()
  channels!: string[];

  @IsOptional()
  @IsObject()
  delayConfig?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'])
  priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateNotificationRuleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  event?: string;

  @IsOptional()
  @IsObject()
  conditions?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  recipientConfig?: { type: 'ROLE' | 'USER' | 'RECORD_OWNER'; value: string }[];

  @IsOptional()
  @IsArray()
  channels?: string[];

  @IsOptional()
  @IsObject()
  delayConfig?: Record<string, unknown>;

  @IsOptional()
  @IsIn(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'])
  priority?: 'CRITICAL' | 'HIGH' | 'NORMAL' | 'LOW';

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
