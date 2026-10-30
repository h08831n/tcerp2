import {
  IsArray,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class ApprovalQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'])
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';

  @IsOptional()
  @IsString()
  approvalType?: string;

  @IsOptional()
  @IsString()
  entityType?: string;
}

export class DecideApprovalDto {
  @IsIn(['APPROVED', 'REJECTED'])
  decision!: 'APPROVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CreateApprovalDto {
  /** Registered entity type (workflow_instance is engine-internal and rejected). */
  @IsString()
  entityType!: string;

  @IsUUID()
  entityId!: string;

  @IsString()
  @MaxLength(100)
  approvalType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  /** Optional decision deadline (future ISO date) shown to approvers. */
  @IsOptional()
  @IsISO8601()
  dueAt?: string;

  /** Role codes notified about the new request (default: sales_manager). */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  approverRoles?: string[];
}

export class CancelApprovalDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
