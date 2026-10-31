import { Transform } from 'class-transformer';
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

  /** Phase 9D SMS channel policy: {templateCode?, text?, partyIds?, usePayloadParty?, vars?}. */
  @IsOptional()
  @IsObject()
  smsConfig?: Record<string, unknown>;

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

  /** Phase 9D SMS channel policy: {templateCode?, text?, partyIds?, usePayloadParty?, vars?}. */
  @IsOptional()
  @IsObject()
  smsConfig?: Record<string, unknown>;

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

  // Query-string boolean: 'true'/'false' arrive as strings over HTTP —
  // @IsBoolean alone would reject them (live smoke test finding, Gate G).
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  includePlatform?: boolean;
}

// ─────────────── Phase 9D: SMS center DTOs ───────────────

export class CreateSmsTemplateDto {
  @IsString()
  @MaxLength(60)
  code!: string;

  @IsString()
  @MaxLength(120)
  nameFa!: string;

  /** {var} placeholders resolved from the event payload / explicit vars. */
  @IsString()
  @MaxLength(600)
  bodyTemplate!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateSmsTemplateDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MaxLength(600)
  bodyTemplate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SendSmsDto {
  /** Destination mobile (any Iranian format — canonicalized server-side). */
  @IsString()
  to!: string;

  /** Literal text (interpolated with vars) when no templateCode. */
  @IsOptional()
  @IsString()
  @MaxLength(600)
  text?: string;

  /** Send via a stored template instead of literal text. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  templateCode?: string;

  /** Interpolation variables (merged over an empty object). */
  @IsOptional()
  @IsObject()
  vars?: Record<string, unknown>;

  /** Optional related party recorded on the log row. */
  @IsOptional()
  @IsUUID()
  partyId?: string;

  /** Optional dedup key: the same key reconciles to ONE message (client retries). */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  idempotencyKey?: string;
}

export class SmsMessageQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['QUEUED', 'SENT', 'FAILED'])
  status?: 'QUEUED' | 'SENT' | 'FAILED';

  @IsOptional()
  @IsIn(['AUTOMATION', 'NOTIFICATION_RULE', 'MANUAL'])
  source?: 'AUTOMATION' | 'NOTIFICATION_RULE' | 'MANUAL';
}
