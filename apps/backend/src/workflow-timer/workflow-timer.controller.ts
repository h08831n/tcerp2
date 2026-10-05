import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { TimerStatus } from '@prisma/client';import { WorkflowTimerService } from './workflow-timer.service';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequestContext } from '../auth/auth.service';
import { CompanyContextService } from '../companies/company-context.service';
import { IsDateString, IsObject, IsString, IsUUID, MinLength } from 'class-validator';

export class ScheduleTimerDto {
  @IsUUID()
  workflowInstanceId!: string;

  @IsUUID()
  stateId!: string;

  @IsString()
  @MinLength(1)
  timerType!: string;

  @IsDateString()
  dueAt!: string;

  @IsObject()
  actionConfig!: Record<string, unknown>;
}

@Controller('workflow-timers')
export class WorkflowTimerController {
  constructor(
    private readonly timers: WorkflowTimerService,
    private readonly companyContext: CompanyContextService,
  ) {}

  @Get()
  @RequirePermissions('workflowtimer.view')
  async list(
    @Query('status') status: TimerStatus | undefined,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.timers.list(companyId, status);
  }

  @Post()
  @RequirePermissions('workflowtimer.edit')
  async schedule(
    @Body() dto: ScheduleTimerDto,
    @CurrentUser() actor: { id: string; username: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(actor, request.headers);
    return this.timers.schedule(companyId, {
      workflowInstanceId: dto.workflowInstanceId,
      stateId: dto.stateId,
      timerType: dto.timerType,
      dueAt: new Date(dto.dueAt),
      actionConfig: dto.actionConfig,
    });
  }

  @Post(':id/cancel')
  @RequirePermissions('workflowtimer.edit')
  async cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.requireCompanyId(user, request.headers);
    return this.timers.cancel(companyId, id);
  }
}
