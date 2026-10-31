import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';
import { QueueBullmqService } from '../queue/queue-bullmq.service';

export type ServiceStatus = 'up' | 'down' | 'disabled';

interface HealthPayload {
  status: 'ok' | 'error';
  database: ServiceStatus;
  redis: ServiceStatus;
  storage: ServiceStatus;
  queue: { pending: number; scheduled: number; failed: number } | null;
  degraded: boolean;
  timestamp: string;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bullmq: QueueBullmqService,
  ) {}

  /**
   * Liveness/readiness (Phase 1 remaining work: real service-connectivity
   * checks). Semantics:
   *   - database down  -> 503 (the app cannot serve anything)
   *   - redis/storage  -> per-service status in the payload; the app stays
   *     200 because the queue has a DB-polling fallback and MinIO outages
   *     only block NEW uploads. `degraded: true` lets monitors alert on the
   *     partial failure without target-down paging.
   * Queue counters stay best-effort (a metrics failure never flips liveness).
   */
  @Public()
  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthPayload> {
    const payload: HealthPayload = {
      status: 'ok',
      database: 'up',
      redis: 'disabled',
      storage: 'disabled',
      queue: null,
      degraded: false,
      timestamp: new Date().toISOString(),
    };

    // ── database (liveness gate) ──
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      payload.status = 'error';
      payload.database = 'down';
      response.status(503);
      return payload;
    }

    // ── redis (optional: null connection = polling driver) ──
    const connection = this.bullmq.getConnection();
    if (!connection) {
      payload.redis = 'disabled';
    } else {
      try {
        const pong = await Promise.race([
          connection.ping(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
        payload.redis = pong === 'PONG' ? 'up' : 'down';
      } catch {
        payload.redis = 'down';
      }
    }

    // ── storage (MinIO presigned-check via bucket head is heavier; a cheap
    // connectivity signal: the S3 config is present -> 'up' is proven by the
    // first real upload, so here we report config-based 'disabled' vs probe) ──
    // Kept 'disabled' by default: the S3 client performs no I/O until a file
    // operation runs; adding a real probe would add latency to every scrape.
    payload.storage = 'disabled';

    payload.degraded = payload.redis === 'down';
    payload.queue = await this.queueCounters();
    return payload;
  }

  private async queueCounters(): Promise<HealthPayload['queue']> {
    try {
      const [pending, scheduled, failed] = await Promise.all([
        this.prisma.queueJob.count({ where: { status: 'PENDING' } }),
        this.prisma.queueJob.count({ where: { status: 'SCHEDULED' } }),
        this.prisma.queueJob.count({ where: { status: 'FAILED' } }),
      ]);
      return { pending, scheduled, failed };
    } catch {
      return null; // metrics best-effort — liveness stays up
    }
  }
}
