import { IsOptional, IsString, IsUUID } from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class AuditQueryDto extends PaginationDto {
  @IsOptional()
  @IsString()
  entityType?: string;

  @IsOptional()
  @IsString()
  entityId?: string;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  action?: string;
}

/** Well-known audit actions used across the foundation modules. */
export const AuditAction = {
  CREATE: 'CREATE',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  ARCHIVE: 'ARCHIVE',
  LOGIN: 'LOGIN',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  REFRESH_TOKEN_REUSE: 'REFRESH_TOKEN_REUSE',
  PASSWORD_RESET: 'PASSWORD_RESET',
  ROLES_CHANGED: 'ROLES_CHANGED',
  PERMISSIONS_CHANGED: 'PERMISSIONS_CHANGED',
  OVERRIDE: 'OVERRIDE',
  EXPORT: 'EXPORT',
  IMPORT: 'IMPORT',
} as const;
export type AuditActionType = (typeof AuditAction)[keyof typeof AuditAction];
