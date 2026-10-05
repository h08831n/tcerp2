import { Body, Controller, Get, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { SettingsService } from './settings.service';
import { SettingQueryDto, UpsertSettingDto } from './settings.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

@Controller('settings')
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('settings.view')
  async list(
    @Query() query: SettingQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.settingsService.list(companyId, query);
  }

  /** Upsert one setting ({key, value, category}) in the active company. */
  @Put()
  @RequirePermissions('settings.edit')
  async upsert(
    @Body() dto: UpsertSettingDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.settingsService.upsert(companyId, dto, actor, this.ctx(request));
  }
}
