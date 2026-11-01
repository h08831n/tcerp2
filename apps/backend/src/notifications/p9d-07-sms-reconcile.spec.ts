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

  it('R-1 (review 96f9af0): Pass A TERMINATES with a persistently failing queue (no infinite loop)', async () => {
    const breakingQueue = {
      enqueue: async () => {
        throw new Error('persistant queue outage');
      },
    };
    const broken = new SmsService(prisma as never, breakingQueue as unknown as QueueService, {
      record: async () => undefined,
    } as never);
    const stuck = await makeStuckRow();

    // The sweep must RETURN (bounded, observable) — never spin forever.
    const result = await Promise.race([
      broken.reconcileStuckQueued(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('sweep did not terminate within 5s — infinite loop')), 5000),
      ),
    ]);
    expect(result).toEqual({ requeued: 0, detached: 0, markedFailed: 0 });
    // The row stays QUEUED/queuedJobId=null — the NEXT sweep retries it.
    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(after.status).toBe('QUEUED');
    expect(after.queuedJobId).toBeNull();
  });

  it('R-2 (review 96f9af0): Pass B examines ALL pages — 520 linked rows, 500 in-progress + 20 terminal', async () => {
    // Deterministic ids (hex-sorted): the 500 PENDING-linked rows come FIRST
    // so any take-200 sweep that does not advance its cursor stops after the
    // first page and never reaches the 20 FAILED-linked rows on page 3.
    const stamp = Date.now();
    const mkId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    // Fixture-only id space (mkId 1..2000 covers sms rows 1..520 + job rows
    // 1001..1520 across runs) — clear leftovers from an interrupted run first.
    const fixtureIds = Array.from({ length: 2000 }, (_, i) => mkId(i + 1));
    await prisma.smsMessage.deleteMany({ where: { id: { in: fixtureIds } } });
    await prisma.queueJob.deleteMany({ where: { id: { in: fixtureIds } } });
    const smsRows = Array.from({ length: 520 }, (_, i) => ({
      id: mkId(i + 1),
      companyId: INTEGRATION_COMPANY_ID,
      to: '09120000003',
      text: `R-2 sweep ${stamp} #${i + 1}`,
      status: 'QUEUED' as const,
      source: 'NOTIFICATION_RULE' as const,
      idempotencyKey: `r2-${stamp}-${i + 1}`,
      queuedJobId: mkId(1000 + i + 1),
    }));
    const jobRows = smsRows.map((s, i) => ({
      id: s.queuedJobId!,
      companyId: INTEGRATION_COMPANY_ID,
      jobType: 'sms.send',
      payload: { smsMessageId: s.id },
      status: i >= 500 ? ('FAILED' as const) : ('PENDING' as const),
      maxAttempts: 3,
      idempotencyKey: `sms-job:${s.id}`,
    }));
    await prisma.queueJob.createMany({ data: jobRows });
    await prisma.smsMessage.createMany({ data: smsRows });
    messageIds.push(...smsRows.map((s) => s.id));

    const result = await sms.reconcileStuckQueued();
    // ALL 20 terminal rows must be examined regardless of page boundaries.
    expect(result.markedFailed).toBe(20);
    // In-progress rows belong to the queue — untouched.
    const stillQueued = await prisma.smsMessage.count({
      where: { id: { in: smsRows.slice(0, 500).map((s) => s.id) }, status: 'QUEUED' },
    });
    expect(stillQueued).toBe(500);
  }, 120_000);

  it('R-3 (review 96f9af0): two replicas racing the sweep produce exactly ONE job per row', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await makeStuckRow();
      ids.push(row.id);
    }
    // Two independent service instances (replicas) sweep concurrently.
    const replicaA = new SmsService(prisma as never, makeQueueService(prisma) as never, {
      record: async () => undefined,
    } as never);
    const replicaB = new SmsService(prisma as never, makeQueueService(prisma) as never, {
      record: async () => undefined,
    } as never);
    await Promise.all([replicaA.reconcileStuckQueued(), replicaB.reconcileStuckQueued()]);

    for (const id of ids) {
      const jobs = await prisma.queueJob.findMany({
        where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: `sms-job:${id}` },
      });
      expect(jobs).toHaveLength(1); // unique stable key — no duplicate job
      const row = await prisma.smsMessage.findUniqueOrThrow({ where: { id } });
      expect(row.queuedJobId).toBe(jobs[0].id);
    }
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, OR: messageIds.map((id) => ({ idempotencyKey: `sms-job:${id}` })) },
    });
    await prisma.smsMessage.deleteMany({ where: { id: { in: messageIds } } });
    await disconnectIntegrationPrisma();
  });
});
