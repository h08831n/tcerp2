import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { QueuePriority } from '@prisma/client';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { QueueService } from './queue.service';
import { QueueJobQueryDto } from './queue.dto';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

class EnqueueJobDto {
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
  constructor(private readonly queueService: QueueService) {}

  @Post()
  @RequirePermissions('queue.enqueue')
  enqueue(@Body() dto: EnqueueJobDto, @CurrentUser() user?: { id: string }) {
    return this.queueService.enqueue({
      jobType: dto.jobType,
      payload: dto.payload ?? {},
      priority: dto.priority,
      idempotencyKey: dto.idempotencyKey,
      createdBy: user?.id,
    });
  }

  @Get()
  @RequirePermissions('queue.view')
  list(@Query() query: QueueJobQueryDto) {
    return this.queueService.list(query);
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
