import { ClaimsService } from './claims.service';
import { PartyOperationalBalanceService } from './party-balance.service';

/**
 * GATE TEST 05 — customer receipt claim: creates an UNMATCHED claim and
 * DECREASES the party operational balance by the amount.
 */
describe('05 customer-receipt-claim', () => {
  const COMPANY = 'company-1';

  function makeMocks(existingBalance: unknown = null) {
    const createdClaims: Record<string, unknown>[] = [];
    const createdBalances: Record<string, unknown>[] = [];
    const updatedBalances: Record<string, unknown>[] = [];
    const trx = {
      operationalSettlementClaim: {
        create: jest.fn(async (args: { data: object }) => {
          createdClaims.push(args as unknown as Record<string, unknown>);
          return { id: 'claim-1', ...args.data, status: 'UNMATCHED' };
        }),
      },
      partyOperationalBalance: {
        findUnique: jest.fn().mockResolvedValue(existingBalance),
        create: jest.fn(async (args: { data: object }) => {
          createdBalances.push(args as unknown as Record<string, unknown>);
          return args;
        }),
        updateMany: jest.fn(async (args: Record<string, unknown>) => {
          updatedBalances.push(args);
          return { count: 1 };
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
    const balance = new PartyOperationalBalanceService(prisma as never);
    const audit = { record: jest.fn() };
    const notifications = {
      dispatchRulesForEvent: jest.fn().mockResolvedValue(0),
      createNotifications: jest.fn().mockResolvedValue([]),
    };
    const service = new ClaimsService(
      prisma as never,
      balance as never,
      audit as never,
      notifications as never,
    );
    return { service, trx, createdClaims, createdBalances, updatedBalances, audit, notifications };
  }

  it('creates an UNMATCHED claim and decreases the balance', async () => {
    const { service, createdClaims, createdBalances } = makeMocks();

    const claim = await service.createAndAudit(
      COMPANY,
      {
        direction: 'CUSTOMER_RECEIPT',
        partyId: 'party-1',
        salesDocumentId: 'sale-1',
        amount: 250,
      },
      { id: 'u1', username: 'sales' },
      {},
    );

    expect(claim.status).toBe('UNMATCHED');
    expect(createdClaims[0].data).toEqual(
      expect.objectContaining({
        companyId: COMPANY,
        direction: 'CUSTOMER_RECEIPT',
        salesDocumentId: 'sale-1',
        purchaseDocumentId: undefined,
        amount: 250,
        declaredBy: 'u1',
      }),
    );
    // Customer receipt → the party owes us less: balance decreases by amount.
    expect(createdBalances[0].data).toEqual(
      expect.objectContaining({ companyId: COMPANY, partyId: 'party-1', balance: -250 }),
    );
  });

  it('decreases an existing positive balance', async () => {
    const { service, updatedBalances } = makeMocks({
      id: 'bal-1',
      companyId: COMPANY,
      partyId: 'party-1',
      balance: '1000',
      version: 3,
    });
    await service.create(
      COMPANY,
      {
        direction: 'CUSTOMER_RECEIPT',
        partyId: 'party-1',
        salesDocumentId: 'sale-1',
        amount: 400,
      },
      { id: 'u1', username: 'sales' },
      {},
    );
    expect(updatedBalances[0]).toEqual(
      expect.objectContaining({
        where: { id: 'bal-1', version: 3 },
        data: expect.objectContaining({ balance: 600, version: 4 }),
      }),
    );
  });
});
