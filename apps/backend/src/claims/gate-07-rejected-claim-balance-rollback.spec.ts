import { ValidationError } from '../common/errors';
import { ClaimsService } from './claims.service';
import { PartyOperationalBalanceService } from './party-balance.service';

/**
 * GATE TEST 07 — rejected claim balance rollback: reject restores the balance
 * to its original value, stores status+reason, records audit (CLAIM_REJECTED,
 * entityType 'claim') + notification, and matching after reject errors.
 */
describe('07 rejected-claim-balance-rollback', () => {
  const COMPANY = 'company-1';

  const UNMATCHED_CLAIM = {
    id: 'claim-1',
    companyId: COMPANY,
    direction: 'CUSTOMER_RECEIPT',
    partyId: 'party-1',
    salesDocumentId: 'sale-1',
    purchaseDocumentId: null,
    amount: '250',
    status: 'UNMATCHED',
    declaredBy: 'declarer-1',
    rejectionReason: null,
  };

  function makeMocks(existingBalance: unknown, claimRow: unknown) {
    const balanceUpdates: Record<string, unknown>[] = [];
    const claimUpdates: Record<string, unknown>[] = [];
    const audit = { record: jest.fn() };
    const notifications = {
      dispatchRulesForEvent: jest.fn().mockResolvedValue(0),
      createNotifications: jest.fn().mockResolvedValue([{}]),
    };
    const trx = {
      operationalSettlementClaim: {
        findUnique: jest.fn().mockResolvedValue(claimRow),
        update: jest.fn(async (args: Record<string, unknown>) => {
          claimUpdates.push(args);
          return { ...UNMATCHED_CLAIM, ...(args.data as object) };
        }),
      },
      partyOperationalBalance: {
        findUnique: jest.fn().mockResolvedValue(existingBalance),
        create: jest.fn(),
        updateMany: jest.fn(async (args: Record<string, unknown>) => {
          balanceUpdates.push(args);
          return { count: 1 };
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
    const service = new ClaimsService(
      prisma as never,
      new PartyOperationalBalanceService(prisma as never) as never,
      audit as never,
      notifications as never,
    );
    return { service, balanceUpdates, claimUpdates, audit, notifications, trx };
  }

  it('reject restores the balance, stores the reason, audits and notifies', async () => {
    // The customer receipt decreased the balance to -250; reject restores +250.
    const { service, balanceUpdates, claimUpdates, audit, notifications } = makeMocks(
      { id: 'bal-1', companyId: COMPANY, partyId: 'party-1', balance: '-250', version: 2 },
      UNMATCHED_CLAIM,
    );

    const rejected = await service.reject(
      COMPANY,
      'claim-1',
      'مبلغ اشتباه بود',
      { id: 'u2', username: 'manager' },
      {},
    );

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.rejectionReason).toBe('مبلغ اشتباه بود');
    expect(balanceUpdates[0]).toEqual(
      expect.objectContaining({
        where: { id: 'bal-1', version: 2 },
        data: expect.objectContaining({ balance: 0, version: 3 }),
      }),
    );
    expect(claimUpdates[0].data).toEqual(
      expect.objectContaining({ status: 'REJECTED', rejectionReason: 'مبلغ اشتباه بود' }),
    );
    // Audit doubles as the timeline event for the claim.
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: 'claim',
        entityId: 'claim-1',
        action: 'CLAIM_REJECTED',
        companyId: COMPANY,
        oldValues: { status: 'UNMATCHED' },
        newValues: expect.objectContaining({ status: 'REJECTED' }),
      }),
    );
    // No rules matched → direct IN_APP notification for the declarer.
    expect(notifications.dispatchRulesForEvent).toHaveBeenCalledWith(
      'payment.rejected',
      expect.objectContaining({ claimDirection: 'CUSTOMER_RECEIPT', claimId: 'claim-1' }),
      expect.objectContaining({ relatedEntityType: 'claim', relatedEntityId: 'claim-1' }),
    );
    expect(notifications.createNotifications).toHaveBeenCalledWith(
      ['declarer-1'],
      expect.objectContaining({ relatedEntityType: 'claim', relatedEntityId: 'claim-1' }),
    );
  });

  it('matching after reject is an error', async () => {
    const { service } = makeMocks(
      { id: 'bal-1', companyId: COMPANY, partyId: 'party-1', balance: '0', version: 3 },
      { ...UNMATCHED_CLAIM, status: 'REJECTED', rejectionReason: 'x' },
    );
    await expect(
      service.match(
        COMPANY,
        'claim-1',
        { receiptId: 'rec-1' },
        { id: 'u2', username: 'manager' },
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejecting an already matched claim is an error', async () => {
    const { service } = makeMocks(
      { id: 'bal-1', companyId: COMPANY, partyId: 'party-1', balance: '-250', version: 2 },
      { ...UNMATCHED_CLAIM, status: 'MATCHED' },
    );
    await expect(
      service.reject(COMPANY, 'claim-1', 'reason', { id: 'u2', username: 'manager' }, {}),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a supplier payment claim reject restores a positive balance', async () => {
    const { service, balanceUpdates } = makeMocks(
      { id: 'bal-2', companyId: COMPANY, partyId: 'party-9', balance: '300', version: 1 },
      { ...UNMATCHED_CLAIM, direction: 'SUPPLIER_PAYMENT', partyId: 'party-9', amount: '300' },
    );
    await service.reject(COMPANY, 'claim-1', 'double', { id: 'u2', username: 'manager' }, {});
    expect(balanceUpdates[0]).toEqual(
      expect.objectContaining({
        where: { id: 'bal-2', version: 1 },
        data: expect.objectContaining({ balance: 0, version: 2 }),
      }),
    );
  });
});
