import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

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

/**
 * Mini-Gate: notification list query — user-scoped by definition, with an
 * optional company filter. `includePlatform` also returns platform-wide
 * (companyId null) notifications.
 */
export class NotificationQueryDto extends PaginationDto {
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @IsOptional()
  @IsIn(['UNREAD', 'READ'])
  status?: 'UNREAD' | 'READ';

  @IsOptional()
  @IsBoolean()
  includePlatform?: boolean;
}
