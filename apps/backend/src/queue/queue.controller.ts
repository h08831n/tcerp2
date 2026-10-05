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
import { QueuePriority } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { QueueService } from './queue.service';
import { QueueJobQueryDto } from './queue.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CompanyContextService } from '../companies/company-context.service';

export class EnqueueJobDto {
  @IsString()
  @MaxLength(100)
  jobType!: string;

  @IsOptional()
  payload?: unknown;

  @IsOptional()
  @IsIn(['CRITICAL', 'HIGH', 'NORMAL', 'LOW'])
  priority?: QueuePriority;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  idempotencyKey?: string;
}

@Controller('queue/jobs')
export class QueueController {
  constructor(
    private readonly queueService: QueueService,
    private readonly companyContext: CompanyContextService,
  ) {}

  /** companyId comes from the company context; null = platform-level job. */
  @Post()
  @RequirePermissions('queue.enqueue')
  async enqueue(
    @Body() dto: EnqueueJobDto,
    @CurrentUser() user?: { id: string; username: string },
    @Req() request?: Request,
  ) {
    const companyId = user
      ? await this.companyContext.resolveCompanyId(user, request!.headers)
      : null;
    return this.queueService.enqueue({
      jobType: dto.jobType,
      payload: dto.payload ?? {},
      companyId,
      priority: dto.priority,
      idempotencyKey: dto.idempotencyKey,
      createdBy: user?.id,
    });
  }

  @Get()
  @RequirePermissions('queue.view')
  async list(
    @Query() query: QueueJobQueryDto,
    @CurrentUser() user: { id: string },
    @Req() request: Request,
  ) {
    const companyId = await this.companyContext.resolveCompanyId(user, request.headers);
    return this.queueService.list({
      ...query,
      companyId,
      skip: query.skip,
      take: query.take,
    });
  }

  @Post(':id/retry')
  @RequirePermissions('queue.retry')
  retry(@Param('id', ParseUUIDPipe) id: string) {
    return this.queueService.retry(id);
  }

  @Post(':id/cancel')
  @RequirePermissions('queue.retry')
  cancel(@Param('id', ParseUUIDPipe) id: string) {
    return this.queueService.cancel(id);
  }
}
