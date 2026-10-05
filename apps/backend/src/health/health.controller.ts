import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness/readiness: 200 when the database answers, 503 otherwise. */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) response: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { status: 'ok', database: 'up', timestamp: new Date().toISOString() };
    } catch {
      response.status(503);
      return { status: 'error', database: 'down', timestamp: new Date().toISOString() };
    }
  }
}
