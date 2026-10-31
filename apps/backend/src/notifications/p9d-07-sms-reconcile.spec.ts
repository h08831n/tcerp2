import {
  describeIntegration,
  disconnectIntegrationPrisma,
  INTEGRATION_COMPANY_ID,
  integrationPrisma,
} from '../testing/integration';
import { makeQueueService } from '../testing/p5-fixtures';
import { QueueService } from '../queue/queue.service';
import { SmsMessage, SmsMessageSource, SmsMessageStatus } from '@prisma/client';
import { SmsService } from './sms.service';

/**
 * p9d-07 (BUG-12 + P1-4/P1-5 review): no SMS row may stay QUEUED forever.
 * The boot/periodic reconcile sweep re-enqueues crash-window rows with the
 * SAME stable idempotency key (`sms-job:{id}`), honors the PERSISTED
 * scheduledFor delay, detaches rows whose job row vanished, and marks
 * terminal-job-without-write-back rows FAILED (never auto-resent).
 */
describeIntegration('p9d-07 sms stuck-QUEUED reconciliation', () => {
  const prisma = integrationPrisma();
  let sms: SmsService;
  const messageIds: string[] = [];
  let seq = 0;

  beforeAll(() => {
    sms = new SmsService(prisma as never, makeQueueService(prisma) as never, {
      record: async () => undefined,
    } as never);
  });

  async function makeStuckRow(scheduledFor?: Date): Promise<SmsMessage> {
    seq += 1;
    const row = await prisma.smsMessage.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        to: '09120000001',
        text: `p9d-07 reconcile ${seq}`,
        status: SmsMessageStatus.QUEUED,
        source: SmsMessageSource.NOTIFICATION_RULE,
        idempotencyKey: `p9d-07-${Date.now()}-${seq}`,
        queuedJobId: null,
        scheduledFor: scheduledFor ?? null,
      },
    });
    messageIds.push(row.id);
    return row;
  }

  it('a QUEUED row without a job is re-enqueued by the sweep with the same stable key', async () => {
    const stuck = await makeStuckRow();

    const result = await sms.reconcileStuckQueued();
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(after.status).toBe('QUEUED'); // only the real handler flips status
    expect(after.queuedJobId).toBeTruthy();

    const job = await prisma.queueJob.findUniqueOrThrow({
      where: { companyId_idempotencyKey: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `sms-job:${stuck.id}` } },
    });
    expect(job.jobType).toBe('sms.send');
    expect((job.payload as { smsMessageId: string }).smsMessageId).toBe(stuck.id);

    // Second sweep is idempotent — no duplicate job, no new linkage.
    const before = await prisma.queueJob.count({
      where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `sms-job:${stuck.id}` },
    });
    await sms.reconcileStuckQueued();
    expect(
      await prisma.queueJob.count({
        where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `sms-job:${stuck.id}` },
      }),
    ).toBe(before);
  });

  it('an enqueue failure surfaces AND leaves the row reconcilable (crash window)', async () => {
    const breakingQueue = {
      enqueue: async () => {
        throw new Error('simulated crash between row insert and enqueue');
      },
    };
    const broken = new SmsService(prisma as never, breakingQueue as unknown as QueueService, {
      record: async () => undefined,
    } as never);

    await expect(
      broken.enqueueSend(INTEGRATION_COMPANY_ID, {
        to: '09120000002',
        text: 'p9d-07 crash window',
        source: SmsMessageSource.MANUAL,
        idempotencyKey: `p9d-07-crash-${Date.now()}`,
      }),
    ).rejects.toThrow('simulated crash');

    const stuck = await prisma.smsMessage.findFirstOrThrow({
      where: { companyId: INTEGRATION_COMPANY_ID, to: '09120000002', queuedJobId: null },
    });
    messageIds.push(stuck.id);
    expect(stuck.status).toBe('QUEUED');

    const result = await sms.reconcileStuckQueued();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const healed = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(healed.queuedJobId).toBeTruthy();
  });

  it('P1-5: the persisted scheduledFor delay is honored on recovery (24h stays 24h)', async () => {
    // A delayed message whose job was never committed (crash window).
    const in24h = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const stuck = await makeStuckRow(in24h);

    const result = await sms.reconcileStuckQueued();
    expect(result.requeued).toBeGreaterThanOrEqual(1);

    const job = await prisma.queueJob.findUniqueOrThrow({
      where: { companyId_idempotencyKey: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `sms-job:${stuck.id}` } },
    });
    // The re-enqueued job is SCHEDULED at/after the persisted send time —
    // never fired early because of the restart.
    expect(job.status).toBe('SCHEDULED');
    expect(new Date(job.scheduledAt).getTime()).toBeGreaterThanOrEqual(in24h.getTime() - 2000);
  });

  it('P1-4: a row whose job row vanished is detached and re-enqueued', async () => {
    const stuck = await makeStuckRow();
    // Link it to a job id that does not exist (job row lost).
    await prisma.smsMessage.update({
      where: { id: stuck.id },
      data: { queuedJobId: '00000000-0000-4000-8000-00000000dead' },
    });

    const result = await sms.reconcileStuckQueued();
    expect(result.detached).toBeGreaterThanOrEqual(1);

    const healed = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(healed.queuedJobId).toBeTruthy();
    expect(healed.queuedJobId).not.toBe('00000000-0000-4000-8000-00000000dead');
    const job = await prisma.queueJob.findUniqueOrThrow({
      where: { companyId_idempotencyKey: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `sms-job:${stuck.id}` } },
    });
    expect(healed.queuedJobId).toBe(job.id);
  });

  it('P1-4: a terminal job without handler write-back becomes FAILED — never auto-resent', async () => {
    const stuck = await makeStuckRow();
    // Create a job row in a terminal FAILED state (write-back was lost).
    const job = await prisma.queueJob.create({
      data: {
        companyId: INTEGRATION_COMPANY_ID,
        jobType: 'sms.send',
        payload: { smsMessageId: stuck.id },
        status: 'FAILED',
        maxAttempts: 3,
        idempotencyKey: `sms-job:${stuck.id}`,
      },
    });
    await prisma.smsMessage.update({
      where: { id: stuck.id },
      data: { queuedJobId: job.id },
    });

    const result = await sms.reconcileStuckQueued();
    expect(result.markedFailed).toBeGreaterThanOrEqual(1);

    const marked = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(marked.status).toBe('FAILED');
    expect(marked.error).toContain('reconcile');
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, OR: messageIds.map((id) => ({ idempotencyKey: `sms-job:${id}` })) },
    });
    await prisma.smsMessage.deleteMany({ where: { id: { in: messageIds } } });
    await disconnectIntegrationPrisma();
  });
});
