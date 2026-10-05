import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { SettingsService } from './settings.service';
import { SettingQueryDto, UpsertSettingDto } from './settings.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('settings.view')
  list(@Query() query: SettingQueryDto) {
    return this.settingsService.list(query);
  }

  /** Upsert one setting ({key, value, category}). */
  @Put()
  @RequirePermissions('settings.edit')
  upsert(
    @Body() dto: UpsertSettingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    return this.settingsService.upsert(dto, actor, this.ctx(request));
  }
}
