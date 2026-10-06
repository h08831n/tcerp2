import { IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Metadata for a direct upload (POST /files, multipart). Mini-Gate: entityType
 * and entityId are REQUIRED — every upload immediately creates a FileAttachment.
 */
export class UploadFileDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entityType!: string;

  @IsUUID('4')
  entityId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}

export class CreateAttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  entityType!: string;

  @IsUUID('4')
  entityId!: string;

  /** Mini-Gate: the blob no longer stores a filename — attachments own it. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  originalFilename!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  category?: string;
}

export class ListAttachmentsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityType?: string;

  @IsOptional()
  @IsUUID('4')
  entityId?: string;
}
