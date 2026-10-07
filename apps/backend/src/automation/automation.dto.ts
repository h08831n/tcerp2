import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { AutomationActionType, AutomationTriggerType } from '@prisma/client';
import { PaginationDto } from '../common/dto/pagination.dto';

export class CreateAutomationRuleDto {
  @IsString()
  code!: string;

  @IsString()
  nameFa!: string;

  @IsEnum(AutomationTriggerType)
  triggerType!: AutomationTriggerType;

  /** {channels:[...], days:N, ...} — shape depends on the trigger. */
  @IsObject()
  triggerConfig!: Record<string, unknown>;

  /** Notification-condition evaluator shape ({all:[…]} / {any:[…]}). */
  @IsOptional()
  @IsObject()
  conditionConfig?: Record<string, unknown>;

  @IsEnum(AutomationActionType)
  actionType!: AutomationActionType;

  @IsObject()
  actionConfig!: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateAutomationRuleDto {
  @IsOptional()
  @IsString()
  nameFa?: string;

  @IsOptional()
  @IsEnum(AutomationTriggerType)
  triggerType?: AutomationTriggerType;

  @IsOptional()
  @IsObject()
  triggerConfig?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  conditionConfig?: Record<string, unknown>;

  @IsOptional()
  @IsEnum(AutomationActionType)
  actionType?: AutomationActionType;

  @IsOptional()
  @IsObject()
  actionConfig?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class AutomationRunQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  status?: string;
}

export class ManualRunDto {
  /** Record to run against: variantId (PRICE_UPDATED), partyId
   * (CUSTOMER_INACTIVE_DAYS), documentId (QUOTATION_PENDING_DAYS). */
  @IsOptional()
  @IsUUID()
  entityId?: string;

  /** Scan date for daily rules (defaults to today). */
  @IsOptional()
  @IsString()
  date?: string;
}

export class DailyScanRunDto {
  @IsOptional()
  @IsString()
  date?: string;
}
