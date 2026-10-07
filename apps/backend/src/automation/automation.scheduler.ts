import { Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfig, CONFIG } from '../config/configuration';
import { AutomationService } from './automation.service';

/**
 * Seeds the self-perpetuating daily automation scan at boot (06:00 local).
 * The durable QueueJob row (idempotencyKey `automation.daily_scan:{date}`)
 * means bootstrap + handler chaining can never schedule the same day twice;
 * the DB-polling fallback picks the row up when Redis is unavailable.
 * Skipped under NODE_ENV=test (same contract as QueueWorkerManager).
 */
@Injectable()
export class AutomationScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger('AutomationScheduler');

  constructor(
    @Inject(CONFIG) private readonly config: AppConfig,
    private readonly automationService: AutomationService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.NODE_ENV === 'test') return;
    try {
      const jobId = await this.automationService.scheduleNextScan(new Date());
      if (jobId) this.logger.log(`Daily automation scan scheduled (job ${jobId})`);
    } catch (error) {
      // Never break boot because of scheduling.
      this.logger.warn(
        `Could not schedule daily automation scan: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
