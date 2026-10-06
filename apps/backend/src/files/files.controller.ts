import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Readable } from 'node:stream';
import { Response, Request } from 'express';
import { FilesService, UploadedFilePayload } from './files.service';
import { CreateAttachmentDto, ListAttachmentsQueryDto, UploadFileDto } from './files.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { ValidationError } from '../common/errors';

/**
 * Mini-Gate: uploads are attachment-first. POST /files requires entityType +
 * entityId and creates the FileAttachment in one step, scoped to the request's
 * company. Listing and downloading never cross company boundaries.
 */
@Controller('files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  private sendDownload(
    response: Response,
    result: { stream: Readable; contentType: string; filename: string; size: number },
  ): StreamableFile {
    response.setHeader('Content-Type', result.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`,
    );
    response.setHeader('Content-Length', String(result.size));
    return new StreamableFile(result.stream);
  }

  @Post()
  @RequirePermissions('files.upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  async upload(
    @UploadedFile() file: UploadedFilePayload | undefined,
    @Body() dto: UploadFileDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    if (!file) {
      throw new ValidationError('Multipart field "file" is required');
    }
    if (!dto.entityType || !dto.entityId) {
      throw new ValidationError('entityType and entityId are required');
    }
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.filesService.upload(file, dto, companyId, actor, this.ctx(request));
  }

  @Get('attachments')
  @RequirePermissions('files.view')
  async listAttachments(
    @Query() query: ListAttachmentsQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.filesService.listAttachments(companyId, query);
  }

  @Get('attachments/:attachmentId/download')
  @RequirePermissions('files.download')
  async downloadAttachment(
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const result = await this.filesService.downloadAttachment(attachmentId, companyId);
    return this.sendDownload(response, result);
  }

  @Post(':id/attachments')
  @RequirePermissions('files.upload')
  async createAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAttachmentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.filesService.createAttachment(id, dto, companyId, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('files.view')
  async getMeta(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.filesService.getMeta(id, companyId);
  }

  @Get(':id/download')
  @RequirePermissions('files.download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const result = await this.filesService.download(id, companyId);
    return this.sendDownload(response, result);
  }
}
