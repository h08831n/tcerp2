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
import { NotFoundError, ValidationError } from '../common/errors';
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

export interface AttachmentWithBlob extends FileAttachment {
  fileBlob: FileBlob;
}

/** BigInt does not survive JSON.stringify — expose it as a number. */
function toBlobDto(blob: FileBlob): FileBlobDto {
  return { ...blob, size: Number(blob.size) };
}

/**
 * S3-compatible file storage (MinIO locally) with content-addressed dedupe:
 * the sha256 of the payload is the blob identity, so identical uploads are
 * stored once (REQUIREMENTS architecture: Files module).
 *
 * Mini-Gate #8: FileBlob is pure content facts (NO filename). Every upload
 * creates a FileAttachment row carrying the per-upload metadata
 * (originalFilename, displayName, category) and the owning company — two
 * companies uploading identical bytes share ONE blob but keep separate
 * attachments, and neither sees the other's attachments.
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

  /**
   * Upload a file: blob dedupe by sha256, then always create an attachment.
   * `companyId` comes from the request's company context; `originalFilename`
   * comes from the multipart part.
   */
  async upload(
    file: UploadedFilePayload,
    data: { entityType: string; entityId: string; displayName?: string; category?: string },
    companyId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<{ blob: FileBlobDto; attachment: FileAttachment }> {
    if (!data.entityType || !data.entityId) {
      throw new ValidationError('entityType and entityId are required');
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    let blob = await this.prisma.fileBlob.findUnique({ where: { sha256 } });

    if (!blob) {
      const now = new Date();
      const key = `blobs/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${sha256}`;

      await this.ensureBucket();
      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.config.S3_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: file.mimetype,
        }),
      );

      blob = await this.prisma.fileBlob.create({
        data: {
          sha256,
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
        companyId,
        newValues: toBlobDto(blob),
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
    }

    const attachment = await this.prisma.fileAttachment.create({
      data: {
        fileBlobId: blob.id,
        companyId,
        entityType: data.entityType,
        entityId: data.entityId,
        originalFilename: file.originalname,
        displayName: data.displayName,
        category: data.category,
        createdBy: actor.id,
      },
    });
    await this.auditService.record({
      entityType: 'file_attachment',
      entityId: attachment.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: {
        fileBlobId: blob.id,
        entityType: data.entityType,
        entityId: data.entityId,
        originalFilename: file.originalname,
        displayName: data.displayName ?? null,
        category: data.category ?? null,
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { blob: toBlobDto(blob), attachment };
  }

  /** Attach an existing blob to an entity (two-step flow). */
  async createAttachment(
    fileBlobId: string,
    data: {
      entityType: string;
      entityId: string;
      originalFilename: string;
      displayName?: string;
      category?: string;
    },
    companyId: string,
    actor: { id: string; username: string },
    ctx: RequestContext,
  ): Promise<FileAttachment> {
    const blob = await this.prisma.fileBlob.findUnique({ where: { id: fileBlobId } });
    if (!blob) throw new NotFoundError('File not found', { id: fileBlobId });

    const attachment = await this.prisma.fileAttachment.create({
      data: {
        fileBlobId,
        companyId,
        entityType: data.entityType,
        entityId: data.entityId,
        originalFilename: data.originalFilename,
        displayName: data.displayName,
        category: data.category,
        createdBy: actor.id,
      },
    });
    await this.auditService.record({
      entityType: 'file_attachment',
      entityId: attachment.id,
      action: AuditAction.CREATE,
      actor,
      companyId,
      newValues: { ...data, fileBlobId },
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return attachment;
  }

  /**
   * Attachments of the caller's company only (Mini-Gate #8: never expose
   * another company's attachments, even for a shared blob).
   */
  async listAttachments(
    companyId: string,
    filters: { entityType?: string; entityId?: string },
  ): Promise<(AttachmentWithBlob & { blob: FileBlobDto })[]> {
    const rows = await this.prisma.fileAttachment.findMany({
      where: {
        companyId,
        entityType: filters.entityType,
        entityId: filters.entityId,
      },
      include: { fileBlob: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(({ fileBlob, ...attachment }) => ({
      ...attachment,
      fileBlob,
      blob: toBlobDto(fileBlob),
    }));
  }

  async getMeta(id: string, companyId: string): Promise<FileBlobDto & { attachments: FileAttachment[] }> {
    const blob = await this.prisma.fileBlob.findUnique({
      where: { id },
      include: { attachments: { where: { companyId } } },
    });
    if (!blob) throw new NotFoundError('File not found', { id });
    return { ...toBlobDto(blob), attachments: blob.attachments };
  }

  /**
   * Download a blob by id. The Content-Disposition filename is the caller's
   * company attachment name (the blob itself no longer stores one).
   */
  async download(id: string, companyId: string): Promise<DownloadResult> {
    const blob = await this.prisma.fileBlob.findUnique({
      where: { id },
      include: { attachments: { where: { companyId }, orderBy: { createdAt: 'asc' }, take: 1 } },
    });
    if (!blob) throw new NotFoundError('File not found', { id });
    if (blob.attachments.length === 0) {
      // No attachment in this company → the blob is not theirs to download.
      throw new NotFoundError('File not found', { id });
    }

    const result = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: blob.storageKey }),
    );
    return {
      stream: result.Body as unknown as Readable,
      contentType: result.ContentType ?? blob.mimeType,
      filename: blob.attachments[0].originalFilename,
      size: Number(blob.size),
    };
  }

  /** Download through a specific attachment (company-filtered). */
  async downloadAttachment(attachmentId: string, companyId: string): Promise<DownloadResult> {
    const attachment = await this.prisma.fileAttachment.findFirst({
      where: { id: attachmentId, companyId },
      include: { fileBlob: true },
    });
    if (!attachment) throw new NotFoundError('Attachment not found', { id: attachmentId });

    const blob = attachment.fileBlob;
    const result = await this.s3.send(
      new GetObjectCommand({ Bucket: this.config.S3_BUCKET, Key: blob.storageKey }),
    );
    return {
      stream: result.Body as unknown as Readable,
      contentType: result.ContentType ?? blob.mimeType,
      filename: attachment.originalFilename,
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
