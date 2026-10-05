import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { FileAttachment, FileBlob } from '@prisma/client';
import { AppConfig, CONFIG } from '../config/configuration';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { AuditAction } from '../audit/audit.dto';
import { NotFoundError } from '../common/errors';
import { RequestContext } from '../auth/auth.service';

export interface UploadedFilePayload {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface DownloadResult {
  stream: Readable;
  contentType: string;
  filename: string;
  size: number;
}

export type FileBlobDto = Omit<FileBlob, 'size'> & { size: number };
export type FileAttachmentDto = FileAttachment;

/** BigInt does not survive JSON.stringify — expose it as a number. */
function toBlobDto(blob: FileBlob): FileBlobDto {
  return { ...blob, size: Number(blob.size) };
}

/**
 * S3-compatible file storage (MinIO locally) with content-addressed dedupe:
 * the sha256 of the payload is the blob identity, so identical uploads are
 * stored once (REQUIREMENTS architecture: Files module).
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger('FilesService');
  private readonly s3: S3Client;
  private bucketReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {
    this.s3 = new S3Client({
      endpoint: this.config.S3_ENDPOINT,
      region: this.config.S3_REGION,
      credentials: {
        accessKeyId: this.config.S3_ACCESS_KEY,
        secretAccessKey: this.config.S3_SECRET_KEY,
      },
      forcePathStyle: this.config.S3_FORCE_PATH_STYLE,
    });
  }

  async upload(
    file: UploadedFilePayload,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<FileBlobDto> {
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');

    const existing = await this.prisma.fileBlob.findUnique({ where: { sha256 } });
    if (existing) {
      // Dedupe hit: the blob is already in object storage.
      return toBlobDto(existing);
    }

    const now = new Date();
    const key = `blobs/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${sha256}/${file.originalname}`;

    await this.ensureBucket();
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.config.S3_BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      }),
    );

    const blob = await this.prisma.fileBlob.create({
      data: {
        sha256,
        filename: file.originalname,
        mimeType: file.mimetype,
        size: BigInt(file.size),
        storageKey: key,
        createdBy: actor.id,
      },
    });

    await this.auditService.record({
      entityType: 'file',
      entityId: blob.id,
      action: AuditAction.CREATE,
      actor,
      newValues: toBlobDto(blob),
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return toBlobDto(blob);
  }

  async createAttachment(
    fileBlobId: string,
    data: { entityType: string; entityId: string; category?: string },
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<FileAttachment> {
    const blob = await this.prisma.fileBlob.findUnique({ where: { id: fileBlobId } });
    if (!blob) throw new NotFoundError('File not found', { id: fileBlobId });

    const attachment = await this.prisma.fileAttachment.create({
      data: {
        fileBlobId,
        entityType: data.entityType,
        entityId: data.entityId,
        category: data.category,
        createdBy: actor.id,
      },
    });
    await this.auditService.record({
      entityType: 'file_attachment',
      entityId: attachment.id,
      action: AuditAction.CREATE,
      actor,
      newValues: { ...data, fileBlobId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return attachment;
  }

  async getMeta(id: string): Promise<FileBlobDto & { attachments: FileAttachment[] }> {
    const blob = await this.prisma.fileBlob.findUnique({
      where: { id },
      include: { attachments: true },
    });
    if (!blob) throw new NotFoundError('File not found', { id });
    return { ...toBlobDto(blob), attachments: blob.attachments };
  }

  async download(id: string): Promise<DownloadResult> {
    const blob = await this.prisma.fileBlob.findUnique({ where: { id } });
    if (!blob) throw new NotFoundError('File not found', { id });

    const result = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: blob.storageKey }),
    );
    return {
      stream: result.Body as unknown as Readable,
      contentType: result.ContentType ?? blob.mimeType,
      filename: blob.filename,
      size: Number(blob.size),
    };
  }

  /** HeadBucket → CreateBucket once, lazily (MinIO may start empty). */
  private async ensureBucket(): Promise<void> {
    if (this.bucketReady) return;
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.config.S3_BUCKET }));
      this.bucketReady = true;
    } catch {
      this.logger.log(`Bucket ${this.config.S3_BUCKET} not found — creating it`);
      await this.s3.send(new CreateBucketCommand({ Bucket: this.config.S3_BUCKET }));
      this.bucketReady = true;
    }
  }
}
