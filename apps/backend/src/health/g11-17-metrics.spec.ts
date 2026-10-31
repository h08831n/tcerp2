import { PrismaService } from '../prisma/prisma.service';
import { MetricsController } from './metrics.controller';
import {
  TEST_INTEGRATION,
  describeIntegration,
  integrationPrisma,
  INTEGRATION_COMPANY_ID,
  disconnectIntegrationPrisma,
} from '../testing/integration';
import { assertSafeIntegrationDatabase } from '../testing/db-guard';

jest.setTimeout(60000);

const DB_URL = process.env.DATABASE_URL;
if (TEST_INTEGRATION) assertSafeIntegrationDatabase(DB_URL);

/**
 * g11-17 — monitoring wiring: the Prometheus exposition endpoint surfaces
 * aggregate operational counters (queue by status, import jobs, pending
 * approvals, SMS backlog) in valid exposition format, with -1 degradation
 * markers instead of 500s when a query fails.
 */
describeIntegration('g11-17 metrics endpoint (monitoring wiring)', () => {
  let prismaService: PrismaService;
  let controller: MetricsController;

  beforeAll(async () => {
    prismaService = new PrismaService();
    await prismaService.$connect();
    controller = new MetricsController(prismaService);
  });

  afterAll(async () => {
    await prismaService.$disconnect().catch(() => undefined);
    await disconnectIntegrationPrisma();
  });

  const itif = TEST_INTEGRATION && DB_URL ? it : (n: string, f: jest.ProvidesCallback) => it.skip(n, f);

  itif('exposes valid Prometheus text with the operational metric families', async () => {
    // seed one deterministic signal: a queued SMS
    const sms = await integrationPrisma().smsMessage.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        to: '09129990001',
        text: 'metrics probe',
        status: 'QUEUED',
        source: 'MANUAL',
        idempotencyKey: `g11-17-metrics-${Date.now()}`,
      },
    });
    let captured = '';
    const response = {
      setHeader: () => undefined,
      send: (body: string) => {
        captured = body;
      },
    } as never;
    await controller.metrics(response);
    const body = captured;

    // exposition format basics
    expect(body).toContain('# TYPE tcerp_queue_jobs gauge');
    for (const status of ['PENDING', 'SCHEDULED', 'FAILED', 'SUCCEEDED']) {
      expect(body).toContain(`tcerp_queue_jobs{status="${status}"}`);
    }
    expect(body).toContain('# TYPE tcerp_import_jobs gauge');
    expect(body).toContain('tcerp_import_jobs{status="RUNNING"}');
    expect(body).toContain('# TYPE tcerp_approvals_pending gauge');
    // the seeded queued SMS is counted
    const smsLine = body.split('\n').find((l) => l.startsWith('tcerp_sms_queued '));
    expect(smsLine).toBeDefined();
    expect(Number(smsLine!.split(' ')[1])).toBeGreaterThanOrEqual(1);
    // no degradation markers in the happy path
    expect(body).not.toContain(' -1');

    await integrationPrisma().smsMessage.delete({ where: { id: sms.id } }).catch(() => undefined);
  });

  itif('degrades to -1 markers (never 500) when a counter query fails', async () => {
    const broken = new Proxy(prismaService, {
      get(target, prop, receiver) {
        if (prop === 'queueJob') {
          throw new Error('INJECTED: metrics query down');
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    const controller = new MetricsController(broken as never);
    let captured = '';
    const response = {
      setHeader: () => undefined,
      send: (body: string) => {
        captured = body;
      },
    } as never;
    await controller.metrics(response);
    const body = captured;
    // queue family degraded; the rest still renders
    expect(body).toContain('tcerp_queue_jobs -1');
    expect(body).toContain('# TYPE tcerp_approvals_pending gauge');
  });
});
