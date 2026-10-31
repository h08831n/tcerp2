import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness/readiness: 200 when the database answers, 503 otherwise.
   * Phase 11 (Gate G hardening): the payload also surfaces lightweight queue
   * observability — PENDING/SCHEDULED depth and FAILED backlog — so a dead
   * worker or a poisoning job is visible to uptime monitors without DB access.
   * These counters are best-effort: a metrics failure never flips the
   * liveness verdict.
   */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) response: Response) {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      let queue: {
        pending: number;
        scheduled: number;
        failed: number;
      } | null = null;
      try {
        const [pending, scheduled, failed] = await Promise.all([
          this.prisma.queueJob.count({ where: { status: 'PENDING' } }),
          this.prisma.queueJob.count({ where: { status: 'SCHEDULED' } }),
          this.prisma.queueJob.count({ where: { status: 'FAILED' } }),
        ]);
        queue = { pending, scheduled, failed };
      } catch {
        queue = null; // metrics best-effort — liveness stays up
      }
      return { status: 'ok', database: 'up', queue, timestamp: new Date().toISOString() };
    } catch {
      response.status(503);
      return { status: 'error', database: 'down', queue: null, timestamp: new Date().toISOString() };
    }
  }
}
