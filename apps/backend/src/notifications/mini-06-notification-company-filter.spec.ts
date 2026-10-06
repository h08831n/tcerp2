import { NotificationService } from './notifications.service';

/**
 * MINI-GATE 06 — notification-company-filter:
 * company notifications carry companyId; listing with a companyId filter never
 * returns another company's notification, while platform (companyId null)
 * notifications are visible when requested.
 */

const NOTIFICATIONS = [
  { id: 'n-1', userId: 'user-1', companyId: 'company-A', title: 'A1', status: 'UNREAD' },
  { id: 'n-2', userId: 'user-1', companyId: 'company-B', title: 'B1', status: 'UNREAD' },
  { id: 'n-3', userId: 'user-1', companyId: null, title: 'platform', status: 'UNREAD' },
];

function makeMocks() {
  const prisma: Record<string, any> = {
    notification: {
      findMany: jest.fn(async (args: { where: { companyId?: unknown; userId: string; OR?: unknown } }) => {
        // emulate prisma equality semantics (companyId: null matches null)
        const companyWhere = (args.where.OR ?? [args.where]) as { companyId?: unknown }[];
        const companyIds = companyWhere.map((w) => w.companyId);
        return NOTIFICATIONS.filter(
          (n) =>
            n.userId === args.where.userId &&
            companyIds.some((cid) => cid === undefined || cid === n.companyId),
        );
      }),
      count: jest.fn(async (args: { where: { userId: string } }) =>
        NOTIFICATIONS.filter((n) => n.userId === args.where.userId).length,
      ),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'n-new',
        status: 'UNREAD',
        ...args.data,
      })),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const service = new NotificationService(
    prisma as never,
    { enqueue: jest.fn() } as never,
  );
  return { service, prisma };
}

describe('mini-06 notification-company-filter', () => {
  it('createNotifications stamps the dispatch companyId on the rows', async () => {
    const { prisma } = makeMocks();
    const service = new NotificationService(prisma as never, { enqueue: jest.fn() } as never);

    await service.createNotifications(['user-1'], {
      companyId: 'company-A',
      title: 'hello',
    });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: 'user-1', companyId: 'company-A' }),
    });
  });

  it('createNotifications with no companyId stores null (platform notification)', async () => {
    const { prisma } = makeMocks();
    const service = new NotificationService(
      prisma as never,
      { enqueue: jest.fn() } as never,
    );

    await service.createNotifications(['user-1'], { title: 'platform-wide' });

    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ companyId: null }),
    });
  });

  it('filtering by company A never returns company B notifications', async () => {
    const { service } = makeMocks();
    const result = await service.listForUser('user-1', { companyId: 'company-A', skip: 0, take: 20 });
    const titles = result.items.map((n) => n.title);
    expect(titles).toContain('A1');
    expect(titles).not.toContain('B1');
    expect(titles).not.toContain('platform');
  });

  it('platform (null company) notifications are visible when requested', async () => {
    const { service } = makeMocks();
    const result = await service.listForUser('user-1', { companyId: null, skip: 0, take: 20 });
    expect(result.items.map((n) => n.title)).toContain('platform');
    expect(result.items.map((n) => n.title)).not.toContain('A1');
  });

  it('includePlatform returns company + platform rows', async () => {
    const { service } = makeMocks();
    const result = await service.listForUser('user-1', {
      companyId: 'company-A',
      includePlatform: true,
      skip: 0,
      take: 20,
    });
    const titles = result.items.map((n) => n.title);
    expect(titles.sort()).toEqual(['A1', 'platform']);
  });

  it('dispatchRulesForEvent passes the rule company into the notification payload', async () => {
    const { prisma } = makeMocks();
    const queueService = { enqueue: jest.fn().mockResolvedValue({}) };
    const service = new NotificationService(prisma as never, queueService as never);

    prisma.notificationRule = {
      findMany: jest.fn().mockResolvedValue([
        {
          id: 'rule-1',
          companyId: 'company-A',
          recipientConfig: [{ type: 'USER', value: 'user-1' }],
          delayConfig: { delayMinutes: 5 },
          conditions: null,
        },
      ]),
    };

    await service.dispatchRulesForEvent('payment.rejected', {}, { companyId: 'company-A', title: 't' });

    expect(queueService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-A',
        payload: expect.objectContaining({
          base: expect.objectContaining({ companyId: 'company-A' }),
        }),
      }),
    );
  });
});
