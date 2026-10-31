import { Controller, Get, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { Public } from '../common/decorators/public.decorator';

/**
 * Prometheus exposition endpoint (Phase 11, Gate G hardening — monitoring
 * wiring). Aggregate OPERATIONAL counters only — no PII, no document
 * contents, no per-user data — safe to scrape from a monitoring system
 * without credentials on an internal network. Metrics failures degrade to
 * partial output (labelled), never a 500: a scraping monitor treats a 500
 * as target-down and pages an operator for the wrong reason.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async metrics(@Res() response: Response): Promise<void> {
    const lines: string[] = [];
    // Prometheus exposition: HELP/TYPE carry the BASE family name (no labels);
    // labelled sample lines follow.
    const family = (name: string, help: string, samples: Array<{ labels?: string; value: number }>): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      for (const sample of samples) {
        lines.push(`${name}${sample.labels ? `{${sample.labels}}` : ''} ${sample.value}`);
      }
    };
    const fail = (name: string, help: string): void => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} -1`);
    };

    // ── queue health (the worker liveness signal) ──
    try {
      const byStatus = await this.prisma.queueJob.groupBy({
        by: ['status'],
        _count: { _all: true },
      });
      const counts = new Map(byStatus.map((r) => [r.status, r._count._all]));
      family(
        'tcerp_queue_jobs',
        'Queue jobs by status — a growing FAILED/RETRYING backlog means a dead or poisoning worker.',
        ['PENDING', 'SCHEDULED', 'PROCESSING', 'RETRYING', 'FAILED', 'SUCCEEDED', 'CANCELLED'].map((status) => ({
          labels: `status="${status}"`,
          value: counts.get(status as never) ?? 0,
        })),
      );
    } catch {
      fail('tcerp_queue_jobs', 'Queue jobs by status (query failed)');
    }

    // ── import jobs by status (batch pipelines) ──
    try {
      const byStatus = await this.prisma.importJob.groupBy({
        by: ['status'],
        _count: { _all: true },
      });
      const counts = new Map(byStatus.map((r) => [r.status, r._count._all]));
      family(
        'tcerp_import_jobs',
        'Import jobs by status — RUNNING jobs stuck high mean a stalled import run.',
        ['VALIDATED', 'RUNNING', 'COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'].map((status) => ({
          labels: `status="${status}"`,
          value: counts.get(status as never) ?? 0,
        })),
      );
    } catch {
      fail('tcerp_import_jobs', 'Import jobs by status (query failed)');
    }

    // ── approvals waiting (operational SLA signal) ──
    try {
      const pending = await this.prisma.approvalRequest.count({ where: { status: 'PENDING' } });
      family('tcerp_approvals_pending', 'Approval requests awaiting a decision.', [{ value: pending }]);
    } catch {
      fail('tcerp_approvals_pending', 'Approval requests awaiting a decision (query failed)');
    }

    // ── SMS backlog (notification pipeline) ──
    try {
      const [queued, failed] = await Promise.all([
        this.prisma.smsMessage.count({ where: { status: 'QUEUED' } }),
        this.prisma.smsMessage.count({ where: { status: 'FAILED' } }),
      ]);
      family('tcerp_sms_queued', 'SMS messages queued but not yet sent.', [{ value: queued }]);
      family('tcerp_sms_failed', 'SMS messages terminally failed.', [{ value: failed }]);
    } catch {
      fail('tcerp_sms_queued', 'SMS messages queued (query failed)');
      fail('tcerp_sms_failed', 'SMS messages failed (query failed)');
    }

    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    response.send(`${lines.join('\n')}\n`);
  }
}
