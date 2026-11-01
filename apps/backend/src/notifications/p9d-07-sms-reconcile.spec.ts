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

  beforeAll(async () => {
    // Self-clean stale rows from interrupted earlier runs of THIS spec
    // (scoped to its idempotencyKey prefixes — never global).
    for (const prefix of ['p9d-07-', 'r2-', 'r4a-']) {
      const stale = await prisma.smsMessage.findMany({
        where: { companyId: INTEGRATION_COMPANY_ID, idempotencyKey: { startsWith: prefix } },
        select: { id: true },
      });
      if (stale.length > 0) {
        await prisma.queueJob.deleteMany({
          where: { companyId: INTEGRATION_COMPANY_ID, OR: stale.map((m) => ({ idempotencyKey: `sms-job:${m.id}` })) },
        });
        await prisma.smsMessage.deleteMany({ where: { id: { in: stale.map((m) => m.id) } } });
      }
    }
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
    const fixtureIds = Array.from({ length: 2000 }, (_, i) => mkId(i + 1));
    // Clear leftovers by BOTH the fixture id space AND the stable keys (the
    // sweep's reenqueue creates relocator jobs with random ids under the
    // same idempotencyKey).
    const staleKeys = smsRows.map((sr) => `sms-job:${sr.id}`);
    await prisma.queueJob.deleteMany({
      where: { OR: [{ id: { in: fixtureIds } }, { idempotencyKey: { in: staleKeys } }] },
    });
    await prisma.smsMessage.deleteMany({ where: { id: { in: fixtureIds } } });
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

  it('R-4a (review 0b4b1aa): >20k stuck rows — Pass B is NEVER starved by the Pass A bound', async () => {
    // 20_010 orphan rows (failing enqueue → bound hit inside Pass A) + 5
    // terminal-linked rows that only Pass B can examine.
    const breakingQueue = {
      enqueue: async () => {
        throw new Error('persistent outage');
      },
    };
    const broken = new SmsService(prisma as never, breakingQueue as unknown as QueueService, {
      record: async () => undefined,
    } as never);
    const mkId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
    const orphanIds = Array.from({ length: 20_010 }, (_, i) => mkId(i + 1));
    // Chunked: Postgres binds every value — 20k rows x 8 cols exceeds the
    // 65535-parameter limit in a single statement.
    for (let i = 0; i < orphanIds.length; i += 2000) {
      await prisma.smsMessage.createMany({
        data: orphanIds.slice(i, i + 2000).map((id) => ({
          id,
          companyId: INTEGRATION_COMPANY_ID,
          to: '09120000004',
          text: 'R-4a starvation',
          status: SmsMessageStatus.QUEUED,
          source: SmsMessageSource.NOTIFICATION_RULE,
          idempotencyKey: `r4a-${id}`,
          queuedJobId: null,
        })),
      });
    }
    const terminalIds: string[] = [];
    for (let i = 1; i <= 5; i += 1) {
      const row = await makeStuckRow();
      const job = await prisma.queueJob.create({
        data: {
          companyId: INTEGRATION_COMPANY_ID,
          jobType: 'sms.send',
          payload: { smsMessageId: row.id },
          status: 'FAILED',
          maxAttempts: 3,
          idempotencyKey: `sms-job:${row.id}`,
        },
      });
      await prisma.smsMessage.update({ where: { id: row.id }, data: { queuedJobId: job.id } });
      terminalIds.push(row.id);
    }

    try {
      const result = await broken.reconcileStuckQueued();
      // Pass B MUST still run after Pass A exhausts its bound.
      expect(result.markedFailed).toBe(5);
      const marked = await prisma.smsMessage.findMany({
        where: { id: { in: terminalIds }, status: 'FAILED' },
      });
      expect(marked).toHaveLength(5);
    } finally {
      // ALWAYS clean the 20k-row fixture — even on assertion failure (the
      // later tests' sweeps must not crawl it).
      await prisma.smsMessage.deleteMany({ where: { id: { in: orphanIds } } });
    }
  }, 180_000);

  it('R-4b (review 0b4b1aa): fairness across sweeps — a small per-pass bound does not starve rows', async () => {
    const attempted: string[] = [];
    const failingQueue = {
      enqueue: async (input: { payload: { smsMessageId: string } }) => {
        attempted.push(input.payload.smsMessageId);
        throw new Error('outage');
      },
    };
    // Injected per-pass row limit (new options contract).
    const limited = new SmsService(
      prisma as never,
      failingQueue as unknown as QueueService,
      { record: async () => undefined } as never,
      { passRowLimit: 2 },
    );
    const rows: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const row = await makeStuckRow();
      rows.push(row.id);
    }
    // Sweep 1: attempts exactly 2 (bounded); Sweep 2: the OTHER 2 (cursor
    // continues across sweeps) — no starvation, no repeats.
    await limited.reconcileStuckQueued();
    expect(attempted).toHaveLength(2);
    await limited.reconcileStuckQueued();
    expect(attempted).toHaveLength(4);
    expect(new Set(attempted).size).toBe(4); // every row attempted exactly once
    expect(rows.every((r) => attempted.includes(r))).toBe(true);
  });

  it('R-5 (review 0b4b1aa): reconcile uses CAS — a concurrent worker write-back is never overwritten', async () => {
    const stuck = await makeStuckRow();
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
    await prisma.smsMessage.update({ where: { id: stuck.id }, data: { queuedJobId: job.id } });

    // Simulate the REAL worker winning the race: between the sweep's READ
    // and its WRITE, the sms.send handler flips the row to SENT. Explicit
    // delegates (no prototype tricks on the Prisma proxy).
    const flip = async () => {
      await prisma.smsMessage.update({
        where: { id: stuck.id },
        data: { status: 'SENT', sentAt: new Date(), providerResponse: { ok: true } },
      });
    };
    let flipped = false;
    const racingPrisma = {
      smsMessage: {
        // Flip EXACTLY in the read-then-write window: when the sweep has
        // just read the page CONTAINING our row, the worker write-back lands
        // before the sweep's own update.
        findMany: async (args: never) => {
          const rows = await prisma.smsMessage.findMany(args);
          if (!flipped && rows.some((r) => r.id === stuck.id)) {
            flipped = true;
            await flip();
          }
          return rows;
        },
        findUnique: (args: never) => prisma.smsMessage.findUnique(args),
        findFirst: (args: never) => prisma.smsMessage.findFirst(args),
        create: (args: never) => prisma.smsMessage.create(args),
        update: (args: never) => prisma.smsMessage.update(args),
        updateMany: (args: never) => prisma.smsMessage.updateMany(args),
        count: (args: never) => prisma.smsMessage.count(args),
        deleteMany: (args: never) => prisma.smsMessage.deleteMany(args),
      },
      queueJob: {
        findMany: (args: never) => prisma.queueJob.findMany(args),
        findUnique: (args: never) => prisma.queueJob.findUnique(args),
        create: (args: never) => prisma.queueJob.create(args),
      },
    };
    const racer = new SmsService(racingPrisma as never, makeQueueService(prisma) as never, {
      record: async () => undefined,
    } as never);

    await racer.reconcileStuckQueued();
    // CAS: the sweep must NOT clobber the newer SENT state.
    const after = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(after.status).toBe('SENT');
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, OR: messageIds.map((id) => ({ idempotencyKey: `sms-job:${id}` })) },
    });
    await prisma.smsMessage.deleteMany({ where: { id: { in: messageIds } } });
    await disconnectIntegrationPrisma();
  });
});
