import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { SequencesService } from './sequences.service';
import { UpdateSequenceDto } from './sequences.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';

@Controller('sequences')
export class SequencesController {
  constructor(private readonly sequencesService: SequencesService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('sequences.view')
  list() {
    return this.sequencesService.list();
  }

  /** Admin/testing endpoint: allocate and return the next number. */
  @Post(':code/allocate')
  @RequirePermissions('sequences.edit')
  allocate(@Param('code') code: string) {
    return this.sequencesService.allocate(code);
  }

  /** Prospective config change only — numbering history is never rewritten. */
  @Put(':id')
  @RequirePermissions('sequences.edit')
  updateConfig(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSequenceDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.sequencesService.updateConfig(id, dto, actor, this.ctx(request));
  }
}
