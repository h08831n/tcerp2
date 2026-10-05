import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { Response, Request } from 'express';
import { FilesService, UploadedFilePayload } from './files.service';
import { CreateAttachmentDto } from './files.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { ValidationError } from '../common/errors';

@Controller('files')
export class FilesController {
  constructor(private readonly filesService: FilesService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Post()
  @RequirePermissions('files.upload')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { fileSize: 50 * 1024 * 1024 },
    }),
  )
  upload(
    @UploadedFile() file: UploadedFilePayload | undefined,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    if (!file) {
      throw new ValidationError('Multipart field "file" is required');
    }
    return this.filesService.upload(file, actor, this.ctx(request));
  }

  @Post(':id/attachments')
  @RequirePermissions('files.upload')
  createAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateAttachmentDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.filesService.createAttachment(id, dto, actor, this.ctx(request));
  }

  @Get(':id')
  @RequirePermissions('files.view')
  getMeta(@Param('id', ParseUUIDPipe) id: string) {
    return this.filesService.getMeta(id);
  }

  @Get(':id/download')
  @RequirePermissions('files.download')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const result = await this.filesService.download(id);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`,
    );
    response.setHeader('Content-Length', String(result.size));
    return new StreamableFile(result.stream);
  }
}
