import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateAttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entityType: string;

  @IsUUID('4')
  entityId: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}
