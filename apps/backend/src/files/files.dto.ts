import { IsOptional, IsString, IsUUID, MaxLength, MinLength , IsBoolean } from 'class-validator';

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

  /** D-2 Phase 3: DEFAULT DENY — must be explicitly 'true' (multipart
   *  fields arrive as strings) for the customer portal to see this file. */
  @IsOptional()
  @IsBoolean()
  customerVisible?: boolean;
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

  /** D-2 Phase 3 (final): DEFAULT DENY — must be explicitly TRUE for the
   *  customer portal to list/download this attachment. */
  @IsOptional()
  @IsBoolean()
  customerVisible?: boolean;
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
