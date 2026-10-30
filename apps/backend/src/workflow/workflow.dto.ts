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
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PaginationDto } from '../common/dto/pagination.dto';

export class WorkflowStateInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsBoolean()
  isInitial?: boolean;

  @IsOptional()
  @IsBoolean()
  isFinal?: boolean;

  /** Time-in-state budget → REMINDER timer on entry. */
  @IsOptional()
  @IsInt()
  @Min(1)
  slaHours?: number;
}

export class WorkflowActionInputDto {
  @IsIn(['notify'])
  type!: 'notify';

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(20)
  roles?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  body?: string;
}

export class WorkflowTransitionInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsString()
  fromState!: string;

  @IsString()
  toState!: string;

  /** Extra permission the actor must hold (beyond workflow.start). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  requiredPermission?: string;

  /** Structured condition evaluated against the instance context. */
  @IsOptional()
  @IsObject()
  condition?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  requiresApproval?: boolean;

  /** ApprovalRequest.approvalType when requiresApproval (default: transition code). */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  approvalType?: string;

  /** Approval budget → ESCALATION timer on parking. */
  @IsOptional()
  @IsInt()
  @Min(1)
  slaHours?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => WorkflowActionInputDto)
  actions?: WorkflowActionInputDto[];
}

export class CreateWorkflowDefinitionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  code!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  /** Target entity type (loading | goods_receipt | sales_document | purchase_document). */
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  entityType!: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsArray()
  @ArrayMaxSize(64)
  @ValidateNested({ each: true })
  @Type(() => WorkflowStateInputDto)
  states!: WorkflowStateInputDto[];

  @IsArray()
  @ArrayMaxSize(256)
  @ValidateNested({ each: true })
  @Type(() => WorkflowTransitionInputDto)
  transitions!: WorkflowTransitionInputDto[];
}

export class UpdateWorkflowDefinitionDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  entityType?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class StartWorkflowInstanceDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  definitionCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(60)
  entityType!: string;

  @IsString()
  @MinLength(36)
  @MaxLength(36)
  entityId!: string;

  /** Business payload conditions evaluate against. */
  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}

export class ExecuteTransitionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  transitionCode!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CancelWorkflowInstanceDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class WorkflowInstanceQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'COMPLETED', 'CANCELLED'])
  status?: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  definitionCode?: string;
}
