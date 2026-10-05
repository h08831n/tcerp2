import { Prisma } from '@prisma/client';
import { ConflictError } from '../common/errors';
import { TaxAllocationService } from './tax.service';

/**
 * GATE TEST 08 — sales tax invoice ↔ order allocation M:N:
 * the pair (invoice, order) is unique; one invoice may allocate to two
 * orders and two invoices may allocate to one order.
 */
describe('08 sales-tax-allocation-mn', () => {
  function makeService(createImpl: (...args: unknown[]) => unknown) {
    const prisma = {
      salesTaxInvoiceOrderAllocation: { create: jest.fn(createImpl) },
    };
    return { service: new TaxAllocationService(prisma as never), prisma };
  }

  const input = (invoice: string, order: string) => ({
    companyId: 'company-1',
    salesTaxInvoiceId: invoice,
    salesDocumentId: order,
    allocatedAmount: 100,
  });

  it('creates an allocation', async () => {
    const { service, prisma } = makeService(async (args) => ({ id: 'a1', ...(args as object) }));
    const created = await service.allocateSales(input('inv-1', 'order-1'));
    expect(created.id).toBe('a1');
    expect(prisma.salesTaxInvoiceOrderAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ salesTaxInvoiceId: 'inv-1', salesDocumentId: 'order-1' }),
    });
  });

  it('a duplicate pair conflicts (ALLOCATION_EXISTS)', async () => {
    const { service } = makeService(() => {
      throw new Prisma.PrismaClientKnownRequestError('unique', {
        code: 'P2002',
        clientVersion: 'test',
      });
    });
    await expect(service.allocateSales(input('inv-1', 'order-1'))).rejects.toMatchObject({
      message: 'ALLOCATION_EXISTS',
    });
    await expect(service.allocateSales(input('inv-1', 'order-1'))).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it('two invoices may allocate to the same order', async () => {
    const { service } = makeService(async (args) => ({ id: 'ok', ...(args as object) }));
    await expect(service.allocateSales(input('inv-1', 'order-1'))).resolves.toBeTruthy();
    await expect(service.allocateSales(input('inv-2', 'order-1'))).resolves.toBeTruthy();
  });

  it('one invoice may allocate to two orders', async () => {
    const { service } = makeService(async (args) => ({ id: 'ok', ...(args as object) }));
    await expect(service.allocateSales(input('inv-1', 'order-1'))).resolves.toBeTruthy();
    await expect(service.allocateSales(input('inv-1', 'order-2'))).resolves.toBeTruthy();
  });

  it('non-positive amounts are rejected', async () => {
    const { service } = makeService(async (args) => ({ id: 'ok', ...(args as object) }));
    await expect(
      service.allocateSales({ ...input('inv-1', 'order-1'), allocatedAmount: 0 }),
    ).rejects.toMatchObject({ message: 'ALLOCATION_AMOUNT_POSITIVE' });
  });
});
