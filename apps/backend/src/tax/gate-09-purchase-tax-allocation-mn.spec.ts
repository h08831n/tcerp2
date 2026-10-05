import { Prisma } from '@prisma/client';
import { ConflictError } from '../common/errors';
import { TaxAllocationService } from './tax.service';

/**
 * GATE TEST 09 — purchase tax invoice ↔ order allocation M:N (mirror of 08).
 */
describe('09 purchase-tax-allocation-mn', () => {
  function makeService(createImpl: (...args: unknown[]) => unknown) {
    const prisma = {
      purchaseTaxInvoiceOrderAllocation: { create: jest.fn(createImpl) },
    };
    return { service: new TaxAllocationService(prisma as never), prisma };
  }

  const input = (invoice: string, order: string) => ({
    companyId: 'company-1',
    purchaseTaxInvoiceId: invoice,
    purchaseDocumentId: order,
    allocatedAmount: 200,
    allocatedQuantity: 3,
  });

  it('creates an allocation', async () => {
    const { service, prisma } = makeService(async (args) => ({ id: 'a1', ...(args as object) }));
    const created = await service.allocatePurchase(input('pinv-1', 'porder-1'));
    expect(created.id).toBe('a1');
    expect(prisma.purchaseTaxInvoiceOrderAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        purchaseTaxInvoiceId: 'pinv-1',
        purchaseDocumentId: 'porder-1',
      }),
    });
  });

  it('a duplicate pair conflicts (ALLOCATION_EXISTS)', async () => {
    const { service } = makeService(() => {
      throw new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });
    await expect(service.allocatePurchase(input('pinv-1', 'porder-1'))).rejects.toBeInstanceOf(
      ConflictError,
    );
    await expect(service.allocatePurchase(input('pinv-1', 'porder-1'))).rejects.toMatchObject({
      message: 'ALLOCATION_EXISTS',
    });
  });

  it('two invoices may allocate to the same order', async () => {
    const { service } = makeService(async (args) => ({ id: 'ok', ...(args as object) }));
    await expect(service.allocatePurchase(input('pinv-1', 'porder-1'))).resolves.toBeTruthy();
    await expect(service.allocatePurchase(input('pinv-2', 'porder-1'))).resolves.toBeTruthy();
  });

  it('one invoice may allocate to two orders', async () => {
    const { service } = makeService(async (args) => ({ id: 'ok', ...(args as object) }));
    await expect(service.allocatePurchase(input('pinv-1', 'porder-1'))).resolves.toBeTruthy();
    await expect(service.allocatePurchase(input('pinv-1', 'porder-2'))).resolves.toBeTruthy();
  });
});
