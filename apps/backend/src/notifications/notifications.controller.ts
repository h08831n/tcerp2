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
import { randomUUID } from 'crypto';
import {
  NotificationRuleService,
  NotificationService,
} from './notifications.service';
import {
  CreateNotificationRuleDto,
  CreateSmsTemplateDto,
  NotificationQueryDto,
  SendSmsDto,
  SmsMessageQueryDto,
  UpdateNotificationRuleDto,
  UpdateSmsTemplateDto,
} from './notifications.dto';
import { SmsService, SmsTemplateService } from './sms.service';
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
  constructor(
    private readonly notifications: NotificationService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get()
  @RequirePermissions('notifications.view')
  async list(
    @Query() query: NotificationQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    // Phase 9D: absent companyId query resolves the CALLER's company (the
    // x-company-id header / default membership) so the inbox shows the
    // working company; includePlatform=true adds platform-wide rows.
    const companyId =
      query.companyId ?? (await this.companyContext.resolveCompanyId(user, request.headers));
    return this.notifications.listForUser(user.id, {
      companyId,
      status: query.status,
      includePlatform: query.includePlatform,
      skip: query.skip,
      take: query.take,
    });
  }

  /** Mark ONE of my notifications read (Phase 9D): foreign ids are no-ops. */
  @Post(':id/read')
  @RequirePermissions('notifications.view')
  async markRead(@Param('id', ParseUUIDPipe) id: string, @CurrentUser('id') userId: string) {
    const marked = await this.notifications.markRead(userId, id);
    return { marked };
  }

  /** Mark ALL my notifications read (optionally one company's scope). */
  @Post('read-all')
  @RequirePermissions('notifications.view')
  async markAllRead(@Query('companyId') companyId: string | undefined, @CurrentUser('id') userId: string) {
    const marked = await this.notifications.markAllRead(userId, companyId || undefined);
    return { marked };
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


/**
 * SMS center (Phase 9D): the send report IS the durable log; manual send and
 * resend are notifications.edit-gated (operators), the log is viewable by
 * notifications.view holders.
 */
@Controller('notifications/sms')
export class SmsController {
  constructor(
    private readonly sms: SmsService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('notifications.view')
  async list(
    @Query() query: SmsMessageQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.sms.list(companyId, query);
  }

  /** Manual send (REQUIREMENTS §27 کنترل دسترسی): notifications.edit only. */
  @Post('send')
  @RequirePermissions('notifications.edit')
  async send(
    @Body() dto: SendSmsDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const rendered = await this.sms.render(companyId, dto, dto.vars ?? {});
    // Dedup is OPT-IN: a client retrying the same logical send passes
    // idempotencyKey and reconciles to ONE row; a fresh send without one is
    // a NEW message (repeating a legitimate announcement must work).
    const idempotencyKey = dto.idempotencyKey
      ? `sms-manual:${actor.id}:${dto.idempotencyKey}`
      : `sms-manual:${actor.id}:${randomUUID()}`;
    const { message, created } = await this.sms.enqueueSend(companyId, {
      to: dto.to,
      text: rendered.text,
      source: 'MANUAL',
      sourceId: actor.id,
      templateCode: rendered.templateCode ?? undefined,
      partyId: dto.partyId,
      requestedById: actor.id,
      idempotencyKey,
    });
    return { message, created };
  }

  /** Resend a FAILED message as a fresh log row. */
  @Post(':id/resend')
  @RequirePermissions('notifications.edit')
  async resend(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    const message = await this.sms.resend(companyId, id, actor, this.ctx(request));
    return { message };
  }
}

/** SMS templates (REQUIREMENTS §27 قالب‌های قابل تنظیم). */
@Controller('notifications/sms-templates')
export class SmsTemplatesController {
  constructor(
    private readonly templates: SmsTemplateService,
    private readonly companyContext: CompanyContextService,
  ) {}

  private ctx(request: Request): RequestContext {
    return { ip: request.ip, userAgent: request.headers['user-agent'] };
  }

  @Get()
  @RequirePermissions('notifications.view')
  async list(@CurrentUser() user: { id: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.templates.list(companyId);
  }

  @Post()
  @RequirePermissions('notifications.edit')
  async create(
    @Body() dto: CreateSmsTemplateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.create(companyId, dto, actor, this.ctx(request));
  }

  @Patch(':id')
  @RequirePermissions('notifications.edit')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSmsTemplateDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.templates.update(companyId, id, dto, actor, this.ctx(request));
  }

  @Delete(':id')
  @RequirePermissions('notifications.edit')
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.templates.remove(companyId, id, actor, this.ctx(request));
    return { success: true };
  }
}