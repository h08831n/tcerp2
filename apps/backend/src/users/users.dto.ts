import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';
import { normalizeIranMobile } from '../common/utils/phone';
import { UserStatus } from '@prisma/client';

export class UserQueryDto extends PaginationDto {
  @IsOptional()
  @IsIn(['ACTIVE', 'DISABLED', 'LOCKED'])
  status?: 'ACTIVE' | 'DISABLED' | 'LOCKED';
}

export class CreateUserDto {
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  username: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsOptional()
  @IsIn(['fa', 'en'])
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;
}

export class UpdateUserDto {
  /** Optimistic-lock token: must match the stored user version. */
  @IsInt()
  version: number;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  mobile?: string;

  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @IsOptional()
  @IsIn(['fa', 'en'])
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @IsOptional()
  @IsBoolean()
  mustChangePassword?: boolean;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;
}

/**
 * Mini-Gate #1: roles are assigned PER COMPANY. Replaces the old global
 * PUT /users/:id/roles with PUT /users/:id/companies/:companyId/roles.
 */
export class SetUserCompanyRolesDto {
  @IsArray()
  @IsUUID('4', { each: true })
  roleIds: string[];
}
