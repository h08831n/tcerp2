import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class RoleQueryDto extends PaginationDto {}

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  code: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  nameFa: string;

  // IAM-001: optional — the UI collects it; absent = reuse the Persian name.
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  nameEn?: string;

  @IsOptional()
  @IsBoolean()
  isSystem?: boolean;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  nameFa?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  nameEn?: string;

  /** IAM-001: deactivate a role — an inactive role grants NO permissions. */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class SetRolePermissionsDto {
  @IsArray()
  @IsUUID('4', { each: true })
  permissionIds: string[];
}
