import { ValidationError } from '../common/errors';
import { ClaimsService } from './claims.service';
import { PartyOperationalBalanceService } from './party-balance.service';

/**
 * GATE TEST 06 — supplier payment claim: correct balance direction
 * (SUPPLIER_PAYMENT increases the party's balance) and wrong document
 * direction rejected with ValidationError.
 */
describe('06 supplier-payment-claim', () => {
  const COMPANY = 'company-1';

  function makeMocks() {
    const createdBalances: Record<string, unknown>[] = [];
    const trx = {
      operationalSettlementClaim: {
        create: jest.fn(async (args: { data: object }) => ({
          id: 'claim-1',
          ...args.data,
          status: 'UNMATCHED',
        })),
      },
      partyOperationalBalance: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async (args: { data: object }) => {
          createdBalances.push(args as unknown as Record<string, unknown>);
          return args;
        }),
      },
    };
    const prisma = { $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(trx)) };
    const service = new ClaimsService(
      prisma as never,
      new PartyOperationalBalanceService(prisma as never) as never,
      { record: jest.fn() } as never,
      {
        dispatchRulesForEvent: jest.fn().mockResolvedValue(0),
        createNotifications: jest.fn(),
      } as never,
    );
    return { service, createdBalances };
  }

  it('creates an UNMATCHED supplier payment claim and increases the balance', async () => {
    const { service, createdBalances } = makeMocks();

    const claim = await service.createAndAudit(
      COMPANY,
      {
        direction: 'SUPPLIER_PAYMENT',
        partyId: 'party-9',
        purchaseDocumentId: 'purchase-1',
        amount: 300,
      },
      { id: 'u1', username: 'buyer' },
      {},
    );

    expect(claim.status).toBe('UNMATCHED');
    expect(createdBalances[0].data).toEqual(
      expect.objectContaining({ companyId: COMPANY, partyId: 'party-9', balance: 300 }),
    );
  });

  it('rejects a supplier payment that references a sales document', async () => {
    const { service } = makeMocks();
    await expect(
      service.create(
        COMPANY,
        {
          direction: 'SUPPLIER_PAYMENT',
          partyId: 'party-9',
          purchaseDocumentId: 'purchase-1',
          salesDocumentId: 'sale-1' as unknown as undefined,
          amount: 100,
        },
        { id: 'u1', username: 'buyer' },
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a supplier payment without a purchase document', async () => {
    const { service } = makeMocks();
    await expect(
      service.create(
        COMPANY,
        { direction: 'SUPPLIER_PAYMENT', partyId: 'party-9', amount: 100 },
        { id: 'u1', username: 'buyer' },
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects a customer receipt that references a purchase document', async () => {
    const { service } = makeMocks();
    await expect(
      service.create(
        COMPANY,
        {
          direction: 'CUSTOMER_RECEIPT',
          partyId: 'party-1',
          purchaseDocumentId: 'purchase-1',
          amount: 100,
        },
        { id: 'u1', username: 'sales' },
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects non-positive amounts', async () => {
    const { service } = makeMocks();
    await expect(
      service.create(
        COMPANY,
        {
          direction: 'SUPPLIER_PAYMENT',
          partyId: 'party-9',
          purchaseDocumentId: 'purchase-1',
          amount: 0,
        },
        { id: 'u1', username: 'buyer' },
        {},
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
