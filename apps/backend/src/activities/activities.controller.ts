import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Request } from 'express';
import { ActivityPriority, ActivityStatus } from '@prisma/client';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CompanyContextService } from '../companies/company-context.service';
import { PermissionsService } from '../permissions/permissions.service';
import { ActivityService } from './activity.service';

export class CreateActivityTypeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  code!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  nameFa!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string;
}

export class CreateActivityDto {
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  typeCode!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsString()
  relatedEntityType!: string;

  @IsUUID()
  relatedEntityId!: string;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

export class UpdateActivityDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @IsOptional()
  @IsDateString()
  scheduledDate?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  /** Required (min 3 chars) only when overriding a COMPLETED activity. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  overrideReason?: string;
}

export class CompleteActivityDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class CancelActivityDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ActivityListQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'COMPLETED', 'CANCELLED'])
  status?: 'PENDING' | 'COMPLETED' | 'CANCELLED';

  @IsOptional()
  @IsIn(['LOW', 'NORMAL', 'HIGH', 'URGENT'])
  priority?: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

  @IsOptional()
  @IsString()
  typeCode?: string;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;

  @IsOptional()
  @IsString()
  relatedEntityType?: string;

  @IsOptional()
  @IsUUID()
  relatedEntityId?: string;

  @IsOptional()
  @IsDateString()
  dueFrom?: string;

  @IsOptional()
  @IsDateString()
  dueTo?: string;

  @IsOptional()
  @IsIn(['true', 'false'])
  overdueOnly?: 'true' | 'false';

  @IsOptional()
  page?: string;

  @IsOptional()
  pageSize?: string;
}

export class CalendarQueryDto {
  @IsDateString()
  from!: string;

  @IsDateString()
  to!: string;

  /** Comma-separated layers: activities,checks,payments,approvals */
  @IsOptional()
  @IsString()
  layers?: string;

  @IsOptional()
  @IsUUID()
  assignedToId?: string;
}

/**
 * Phase 9A — Activity Engine (REQUIREMENTS §49). Company-scoped via
 * CompanyContextService; permissions enforced by the global guard chain.
 */
@Controller('activities')
export class ActivitiesController {
  constructor(
    private readonly activities: ActivityService,
    private readonly companyContext: CompanyContextService,
    private readonly permissionsService: PermissionsService,
  ) {}

  private async actorScope(user: { id: string }, request: Request) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    const effective = await this.permissionsService.getEffectivePermissions(user.id, companyId);
    const canOverride = effective.has('activities.override');
    return { companyId, canOverride };
  }

  @Get()
  @RequirePermissions('activities.view')
  async list(
    @Query() query: ActivityListQueryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, canOverride } = await this.actorScope(actor, request);
    // record scope: without activities.view_all a user sees only their own
    // assigned activities (OWN scope)
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    const scopeAll = effective.has('activities.view_all');
    return this.activities.list(companyId, {
      status: query.status,
      priority: query.priority,
      typeCode: query.typeCode,
      assignedToId: scopeAll ? query.assignedToId : actor.id,
      relatedEntityType: query.relatedEntityType,
      relatedEntityId: query.relatedEntityId,
      dueFrom: query.dueFrom ? new Date(query.dueFrom) : undefined,
      dueTo: query.dueTo ? new Date(query.dueTo) : undefined,
      overdueOnly: query.overdueOnly === 'true',
      page: query.page ? Number(query.page) : undefined,
      pageSize: query.pageSize ? Number(query.pageSize) : undefined,
    });
  }

  @Get('types')
  @RequirePermissions('activities.view')
  async listTypes(@CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.activities.listTypes(companyId);
  }

  @Post('types')
  @RequirePermissions('activities.override')
  async createType(
    @Body() dto: CreateActivityTypeDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.activities.createType(companyId, dto, actor);
  }

  @Get(':id')
  @RequirePermissions('activities.view')
  async getById(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() actor: { id: string; username: string }, @Req() request: Request) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.activities.getById(companyId, id);
  }

  @Post()
  @RequirePermissions('activities.create')
  async create(
    @Body() dto: CreateActivityDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.activities.create(
      companyId,
      {
        typeCode: dto.typeCode,
        title: dto.title,
        description: dto.description,
        relatedEntityType: dto.relatedEntityType,
        relatedEntityId: dto.relatedEntityId,
        assignedToId: dto.assignedToId,
        priority: dto.priority,
        scheduledDate: dto.scheduledDate ? new Date(dto.scheduledDate) : undefined,
        dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined,
      },
      actor,
    );
  }

  @Post(':id/complete')
  @RequirePermissions('activities.edit')
  async complete(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteActivityDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.activities.complete(companyId, id, actor, dto.note);
    return { status: 'COMPLETED' };
  }

  @Post(':id/cancel')
  @RequirePermissions('activities.edit')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CancelActivityDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    await this.activities.cancel(companyId, id, actor, dto.reason);
    return { status: 'CANCELLED' };
  }

  @Post('calendar')
  @RequirePermissions('activities.view')
  async calendar(
    @Body() dto: CalendarQueryDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const { companyId, canOverride } = await this.actorScope(actor, request);
    const effective = await this.permissionsService.getEffectivePermissions(actor.id, companyId);
    const scopeAll = effective.has('activities.view_all');
    const from = new Date(dto.from);
    const to = new Date(dto.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
      return { layers: {} };
    }
    const layers = (dto.layers ?? 'activities').split(',').map((l) => l.trim()).filter(Boolean);
    return this.activities.calendar(companyId, {
      from,
      to,
      layers,
      assignedToId: scopeAll ? dto.assignedToId : actor.id,
    });
  }
}
