import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  NotificationRuleService,
  NotificationService,
} from './notifications.service';
import {
  CreateNotificationRuleDto,
  NotificationQueryDto,
  UpdateNotificationRuleDto,
} from './notifications.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';

/**
 * Mini-Gate: the current user's notifications. companyId null/absent filters
 * to platform notifications; includePlatform=true shows platform + company.
 */
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @RequirePermissions('notifications.view')
  async list(
    @Query() query: NotificationQueryDto,
    @CurrentUser('id') userId: string,
  ) {
    // Filter: explicit companyId query wins; absent → platform (null) only.
    // includePlatform=true shows company + platform rows.
    const companyId = query.companyId ?? null;
    return this.notifications.listForUser(userId, {
      companyId,
      status: query.status,
      includePlatform: query.includePlatform,
      skip: query.skip,
      take: query.take,
    });
  }
}

@Controller('notifications/rules')
export class NotificationRulesController {
  constructor(
    private readonly rules: NotificationRuleService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('notifications.view')
  async list(
    @Query('event') event: string | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.rules.list(companyId, event);
  }

  @Post()
  @RequirePermissions('notifications.edit')
  async create(
    @Body() dto: CreateNotificationRuleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.rules.create(companyId, dto, actor, this.ctx(request));
  }

  @Patch(':id')
  @RequirePermissions('notifications.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotificationRuleDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.rules.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('notifications.edit')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.rules.remove(companyId, id, actor, this.ctx(request));
  }
}
