import { Body, Controller, Delete, Get, Param, Put, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { SettingsService } from './settings.service';
import { SettingQueryDto } from './settings.dto';
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

  // CORE-003 §4: the LEGACY raw-key PUT /settings endpoint was REMOVED —
  // it accepted arbitrary keys/values with no registry validation (a bypass
  // of the typed settings center). All writes now flow through
  // PUT /settings/catalog/:key with registry-typed validation.

  /** CORE-003 — the settings-center feed: registry + current values. */
  @Get('catalog')
  @RequirePermissions('settings.view')
  async catalog(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.settingsService.catalog(companyId);
  }

  /** CORE-003 — typed upsert with registry validation (by key). */
  @Put('catalog/:key')
  @RequirePermissions('settings.edit')
  async upsertRegistered(
    @Param('key') key: string,
    @Body() body: { value: unknown },
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.settingsService.upsertRegistered(companyId, key, body?.value, actor, this.ctx(request));
  }

  /** CORE-003 — restore a setting to its registry default. */
  @Delete('catalog/:key')
  @RequirePermissions('settings.edit')
  async restoreDefault(
    @Param('key') key: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.settingsService.restoreDefault(companyId, key, actor, this.ctx(request));
  }
}
