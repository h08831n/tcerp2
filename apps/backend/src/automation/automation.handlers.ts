import { Injectable, Logger } from '@nestjs/common';
import { QueueHandler } from '../queue/queue.handlers';
import { AutomationService } from './automation.service';

/**
 * Queue handler `automation.run` (REQUIREMENTS §52): executes ONE automation
 * run row's action. Idempotent — a redelivered job sees the run no longer
 * PENDING and returns without acting, so a duplicate queue delivery can
 * never double-publish/double-SMS.
 */
@Injectable()
export class AutomationRunHandler implements QueueHandler {
  readonly type = 'automation.run';

  constructor(private readonly automationService: AutomationService) {}

  async handle(payload: unknown): Promise<void> {
    const { runId } = (payload ?? {}) as { runId?: string };
    if (!runId) return;
    await this.automationService.executeRun(runId);
  }
}

/**
 * Queue handler `automation.daily_scan`: runs the scheduled daily rules
 * (CUSTOMER_INACTIVE_DAYS / QUOTATION_PENDING_DAYS) for ALL companies, then
 * self-reschedules the next day's 06:00 scan (idempotencyKey per date keeps
 * exactly one scan job per day — bootstrap seeding + handler chaining can
 * never duplicate it).
 */
@Injectable()
export class DailyScanHandler implements QueueHandler {
  readonly type = 'automation.daily_scan';
  private readonly logger = new Logger('DailyScanHandler');

  constructor(private readonly automationService: AutomationService) {}

  async handle(payload: unknown): Promise<void> {
    const input = (payload ?? {}) as { date?: string };
    const summaries = await this.automationService.dailyScan({ date: input.date });
    for (const summary of summaries) {
      this.logger.log(
        `daily_scan ${summary.code}: candidates=${summary.candidates} executed=${summary.executed} ` +
          `duplicates=${summary.skippedDuplicates} conditionSkipped=${summary.conditionSkipped}`,
      );
    }
    // Chain the next day's scan (no-op when the row already exists).
    await this.automationService.scheduleNextScan(new Date());
  }
}
