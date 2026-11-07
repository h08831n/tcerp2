import { IsIn, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

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

  /** D-2 Phase 3: DEFAULT DENY — multipart fields arrive as strings; the
   *  service converts ONLY 'true'/'false' to booleans (customerVisible is
   *  a string here, NOT a boolean — @IsBoolean rejects all strings).
   *  Garbage values are rejected by @IsIn (→ 400). */
  @IsOptional()
  @IsIn(['true', 'false'])
  customerVisible?: string;
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

  /** D-2 Phase 3 (final): DEFAULT DENY — must be explicitly 'true' for the
   *  customer portal to list/download this attachment. */
  @IsOptional()
  @IsIn(['true', 'false'])
  customerVisible?: string;
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
