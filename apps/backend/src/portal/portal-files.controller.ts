import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response, Request } from 'express';
import { StreamableFile } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { PortalAuthGuard } from './portal-auth.guard';
import { PortalBusinessService, PortalSessionContext } from './portal-business.service';

interface PortalRequest extends Request {
  portalSession?: PortalSessionContext;
}

/**
 * Phase 3 — customer portal FILES: list + download attachments on the
 * customer's OWN orders and loadings. Read-only; every access decision is
 * resolved from the verified session (company+party), never from input.
 */
@Public()
@UseGuards(PortalAuthGuard)
@Controller('portal/files')
export class PortalFilesController {
  constructor(private readonly business: PortalBusinessService) {}

  private ctx(request: PortalRequest): PortalSessionContext {
    return {
      companyId: request.portalSession!.companyId,
      partyId: request.portalSession!.partyId,
    };
  }

  @Get()
  async list(@Req() request: PortalRequest) {
    return this.business.listFiles(this.ctx(request));
  }

  @Get(':attachmentId/download')
  async download(
    @Req() request: PortalRequest,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const result = await this.business.downloadFile(this.ctx(request), attachmentId);
    response.setHeader('Content-Type', result.contentType);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(result.filename)}"`,
    );
    response.setHeader('Content-Length', String(result.size));
    return new StreamableFile(result.stream);
  }
}
