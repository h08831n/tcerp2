import { Injectable } from '@nestjs/common';

/**
 * Cycle-breaker for the Redis-outage fallback: QueueService needs to start
 * the DB-polling worker when BullMQ/Redis times out mid-run, but
 * WorkerService already injects QueueService (and QueueWorkerManager injects
 * WorkerService) — a direct dependency would close a DI cycle.
 *
 * QueueWorkerManager registers the real starter at boot; QueueService calls
 * it on fallback. Idempotency lives in the manager (dbWorkerStarted flag).
 */
@Injectable()
export class QueuePollingStarter {
  private starter: (() => void) | null = null;

  register(starter: () => void): void {
    this.starter = starter;
  }

  start(): void {
    this.starter?.();
  }
}
