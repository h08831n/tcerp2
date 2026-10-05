import { evaluateConditions } from './notification-conditions';
import { NotificationRuleService, NotificationService } from './notifications.service';

/**
 * GATE TEST 12 — notification rule conditions: a rule with
 * claimDirection==CUSTOMER_RECEIPT matches only that event; non-matching
 * rules create no notification; delay>0 schedules (queued) instead of
 * creating immediately.
 */
describe('12 notification-rule-conditions', () => {
  describe('evaluateConditions (pure)', () => {
    it('no conditions matches everything', () => {
      expect(evaluateConditions(undefined, {})).toBe(true);
      expect(evaluateConditions(null, {})).toBe(true);
    });

    it('{"all":[...]} requires every condition', () => {
      const conditions = {
        all: [{ field: 'claimDirection', equals: 'CUSTOMER_RECEIPT' }, { field: 'amount', gt: 100 }],
      };
      expect(evaluateConditions(conditions, { claimDirection: 'CUSTOMER_RECEIPT', amount: 250 })).toBe(true);
      expect(evaluateConditions(conditions, { claimDirection: 'SUPPLIER_PAYMENT', amount: 250 })).toBe(false);
      expect(evaluateConditions(conditions, { claimDirection: 'CUSTOMER_RECEIPT', amount: 50 })).toBe(false);
    });

    it('{"any":[...]} requires at least one condition', () => {
      const conditions = { any: [{ field: 'direction', in: ['A', 'B'] }, { field: 'amount', lt: 10 }] };
      expect(evaluateConditions(conditions, { direction: 'B' })).toBe(true);
      expect(evaluateConditions(conditions, { amount: 5 })).toBe(true);
      expect(evaluateConditions(conditions, { direction: 'C', amount: 50 })).toBe(false);
    });

    it('nested all/any groups work', () => {
      const conditions = {
        all: [
          { field: 'event', equals: 'payment.rejected' },
          { any: [{ field: 'claimDirection', equals: 'CUSTOMER_RECEIPT' }, { field: 'priority', equals: 'HIGH' }] },
        ],
      };
      expect(evaluateConditions(conditions, { event: 'payment.rejected', claimDirection: 'CUSTOMER_RECEIPT' })).toBe(true);
      expect(evaluateConditions(conditions, { event: 'payment.rejected', priority: 'HIGH' })).toBe(true);
      expect(evaluateConditions(conditions, { event: 'payment.rejected', claimDirection: 'SUPPLIER_PAYMENT' })).toBe(false);
      expect(evaluateConditions(conditions, { event: 'other', claimDirection: 'CUSTOMER_RECEIPT' })).toBe(false);
    });

    it('supports dotted fields and unknown operators never match', () => {
      expect(evaluateConditions({ all: [{ field: 'a.b', equals: 1 }] }, { a: { b: 1 } })).toBe(true);
      expect(evaluateConditions({ all: [{ field: 'x', bogus: 1 } as never] }, { x: 1 })).toBe(false);
    });
  });

  describe('dispatchRulesForEvent', () => {
    const RULE_BASE = {
      id: 'rule-1',
      companyId: 'company-1',
      code: 'claim-rejected',
      event: 'payment.rejected',
      enabled: true,
      priority: 'NORMAL',
      channels: ['IN_APP'],
      delayConfig: null,
      recipientConfig: [{ type: 'USER', value: 'declarer-1' }],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    function makeMocks(rules: unknown[]) {
      const created: Record<string, unknown>[] = [];
      const prisma = {
        notificationRule: { findMany: jest.fn().mockResolvedValue(rules) },
        notification: {
          create: jest.fn(async (args: Record<string, unknown>) => {
            created.push(args);
            return args;
          }),
        },
        $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
      };
      const queueService = { enqueue: jest.fn(async (input: unknown) => input) };
      const service = new NotificationService(prisma as never, queueService as never);
      const base = {
        companyId: 'company-1',
        title: 'ثبت تسویه رد شد',
        relatedEntityType: 'claim',
        relatedEntityId: 'claim-1',
      };
      return { service, created, prisma, queueService, base };
    }

    it('a rule conditioned on claimDirection==CUSTOMER_RECEIPT matches only that event', async () => {
      const rule = {
        ...RULE_BASE,
        conditions: { all: [{ field: 'claimDirection', equals: 'CUSTOMER_RECEIPT' }] },
      };
      const { service, created } = makeMocks([rule]);
      const payload = { claimDirection: 'CUSTOMER_RECEIPT', claimId: 'claim-1' };

      const dispatched = await service.dispatchRulesForEvent('payment.rejected', payload, {
        companyId: 'company-1',
        title: 't',
        relatedEntityType: 'claim',
        relatedEntityId: 'claim-1',
      });

      expect(dispatched).toBe(1);
      expect(created).toHaveLength(1);
      expect(created[0].data).toEqual(
        expect.objectContaining({ userId: 'declarer-1', relatedEntityType: 'claim' }),
      );

      // The supplier payment event must NOT match the rule.
      const { created: created2 } = makeMocks([rule]);
      const dispatched2 = await new NotificationService(
        { notificationRule: { findMany: jest.fn().mockResolvedValue([rule]) }, notification: { create: created2.push as never }, $transaction: jest.fn() } as never,
        { enqueue: jest.fn() } as never,
      ).dispatchRulesForEvent('payment.rejected', { claimDirection: 'SUPPLIER_PAYMENT' }, {
        companyId: 'company-1',
        title: 't',
      } as never);
      expect(dispatched2).toBe(0);
    });

    it('a non-matching rule creates no notification', async () => {
      const rule = {
        ...RULE_BASE,
        conditions: { all: [{ field: 'claimDirection', equals: 'SUPPLIER_PAYMENT' }] },
      };
      const { service, created } = makeMocks([rule]);
      const dispatched = await service.dispatchRulesForEvent(
        'payment.rejected',
        { claimDirection: 'CUSTOMER_RECEIPT' },
        { companyId: 'company-1', title: 't' } as never,
      );
      expect(dispatched).toBe(0);
      expect(created).toHaveLength(0);
    });

    it('delay>0 schedules a queue job instead of creating notifications', async () => {
      const rule = {
        ...RULE_BASE,
        delayConfig: { delayMinutes: 15 },
        conditions: undefined,
      };
      const { service, created, queueService } = makeMocks([rule]);
      const dispatched = await service.dispatchRulesForEvent(
        'payment.rejected',
        { claimDirection: 'CUSTOMER_RECEIPT' },
        { companyId: 'company-1', title: 't' } as never,
      );
      expect(dispatched).toBe(1);
      expect(queueService.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          jobType: 'notification.dispatch',
          delayMs: 15 * 60_000,
          companyId: 'company-1',
        }),
      );
      expect(created).toHaveLength(0);
    });
  });

  describe('NotificationRuleService CRUD scoping', () => {
    it('rulesForEvent returns only enabled rules of the company ordered by priority', async () => {
      const prisma = {
        notificationRule: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const service = new NotificationRuleService(prisma as never, { record: jest.fn() } as never);
      await service.rulesForEvent('company-1', 'payment.rejected');
      expect(prisma.notificationRule.findMany).toHaveBeenCalledWith({
        where: { companyId: 'company-1', event: 'payment.rejected', enabled: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
      });
    });
  });
});
