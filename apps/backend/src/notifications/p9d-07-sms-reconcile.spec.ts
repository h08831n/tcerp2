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
 * p9d-07 (BUG-12): an SMS row must never be stuck QUEUED forever when the
 * queue.enqueue step fails or the process crashes between the row insert and
 * the job commit. The boot-time reconcile sweep re-enqueues such rows with
 * the SAME stable idempotency key (`sms-job:{id}`) — idempotent, never marks
 * anything SENT itself.
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

  async function makeStuckRow(): Promise<SmsMessage> {
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
      },
    });
    messageIds.push(row.id);
    return row;
  }

  it('a QUEUED row without a job is re-enqueued by the sweep with the same stable key', async () => {
    const stuck = await makeStuckRow();

    const recovered = await sms.reconcileStuckQueued();
    expect(recovered).toBeGreaterThanOrEqual(1);

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

    // The healthy sweep recovers it afterwards.
    const recovered = await sms.reconcileStuckQueued();
    expect(recovered).toBeGreaterThanOrEqual(1);
    const healed = await prisma.smsMessage.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(healed.queuedJobId).toBeTruthy();
  });

  afterAll(async () => {
    await prisma.queueJob.deleteMany({
      where: { companyId: INTEGRATION_COMPANY_ID, OR: messageIds.map((id) => ({ idempotencyKey: `sms-job:${id}` })) },
    });
    await prisma.smsMessage.deleteMany({ where: { id: { in: messageIds } } });
    await disconnectIntegrationPrisma();
  });
});
