import { IsArray, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { PaginationDto } from '../common/dto/pagination.dto';

export class TeamQueryDto extends PaginationDto {}

export class CreateTeamDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name: string;

  @IsOptional()
  @IsUUID('4')
  managerId?: string;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds?: string[];
}

export class UpdateTeamDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name?: string;

  @IsOptional()
  @IsUUID('4')
  managerId?: string | null;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  memberIds?: string[];
}
